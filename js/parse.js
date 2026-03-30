import { Book, Paragraph, Word, Character } from "./book.js";

const PARAGRAPH_SELECTORS = "p,div,li,blockquote,pre,h1,h2,h3,h4,h5,h6";

function getFirstByLocalName(root, tagName) {
    return root.getElementsByTagNameNS("*", tagName)[0] || null;
}

function getAllByLocalName(root, tagName) {
    return Array.from(root.getElementsByTagNameNS("*", tagName));
}

function parseXml(xmlString) {
    return new DOMParser().parseFromString(xmlString, "application/xml");
}

function cleanText(text) {
    return text.replace(/\s+/g, " ");
}

function getAlignment(paragraphElement) {
    const alignAttribute = paragraphElement.getAttribute("align");
    if (alignAttribute) {
        return alignAttribute.toLowerCase();
    }

    const styleAttribute = paragraphElement.getAttribute("style") || "";
    const match = styleAttribute.match(/text-align\s*:\s*([^;]+)/i);
    if (match) {
        return match[1].trim().toLowerCase();
    }

    return "left";
}

function isBoldElement(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) {
        return false;
    }

    const tagName = node.tagName.toLowerCase();
    const style = node.getAttribute("style") || "";

    return (
        tagName === "b" ||
        tagName === "strong" ||
        /font-weight\s*:\s*(bold|[7-9]00)/i.test(style)
    );
}

function isItalicElement(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) {
        return false;
    }

    const tagName = node.tagName.toLowerCase();
    const style = node.getAttribute("style") || "";

    return tagName === "i" || tagName === "em" || /font-style\s*:\s*italic/i.test(style);
}

function isUnderlineElement(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) {
        return false;
    }

    const tagName = node.tagName.toLowerCase();
    const style = node.getAttribute("style") || "";

    return tagName === "u" || /text-decoration\s*:\s*[^;]*underline/i.test(style);
}

function findParagraphElement(textNode) {
    let current = textNode.parentElement;

    while (current) {
        if (current.matches(PARAGRAPH_SELECTORS)) {
            return current;
        }

        current = current.parentElement;
    }

    return null;
}

function getCharacterStyle(textNode) {
    let current = textNode.parentElement;

    let bold = false;
    let italic = false;
    let underline = false;

    while (current) {
        bold = bold || isBoldElement(current);
        italic = italic || isItalicElement(current);
        underline = underline || isUnderlineElement(current);
        current = current.parentElement;
    }

    return { bold, italic, underline };
}

function appendTextToParagraph(paragraph, text, style, paragraphIndex) {
    if (!text.trim()) {
        return;
    }

    const normalizedText = cleanText(text);
    const wordTokens = normalizedText.split(" ").filter(Boolean);

    for (const token of wordTokens) {
        const characters = [];

        for (const letter of token) {
            characters.push(new Character(letter, style.bold, style.italic, style.underline));
        }

        paragraph.words.push(new Word(characters, paragraphIndex));
    }
}

function extractParagraphsFromDocument(contentDocument) {
    const body = getFirstByLocalName(contentDocument, "body");
    if (!body) {
        return [];
    }

    const paragraphs = [];
    const paragraphByElement = new Map();

    const walker = contentDocument.createTreeWalker(body, NodeFilter.SHOW_TEXT);
    let currentNode = walker.nextNode();

    while (currentNode) {
        const paragraphElement = findParagraphElement(currentNode);
        if (!paragraphElement) {
            currentNode = walker.nextNode();
            continue;
        }

        let paragraph = paragraphByElement.get(paragraphElement);

        if (!paragraph) {
            paragraph = new Paragraph(getAlignment(paragraphElement), []);
            paragraphByElement.set(paragraphElement, paragraph);
            paragraphs.push(paragraph);
        }

        const style = getCharacterStyle(currentNode);
        appendTextToParagraph(paragraph, currentNode.nodeValue || "", style, paragraphs.length - 1);
        currentNode = walker.nextNode();
    }

    return paragraphs.filter((paragraph) => paragraph.words.length > 0);
}

function resolveRelativePath(basePath, relativePath) {
    const normalizedBase = basePath.replace(/[^/]*$/, "");
    return new URL(relativePath, `https://example.com/${normalizedBase}`).pathname.slice(1);
}

async function extractPackagePath(zip) {
    const containerFile = zip.file("META-INF/container.xml");
    if (!containerFile) {
        throw new Error("EPUB container.xml was not found.");
    }

    const containerXml = await containerFile.async("string");
    const containerDoc = parseXml(containerXml);
    const rootFile = getFirstByLocalName(containerDoc, "rootfile");

    if (!rootFile) {
        throw new Error("EPUB rootfile entry was not found in container.xml.");
    }

    return rootFile.getAttribute("full-path");
}

async function extractMetadataAndSpine(zip, packagePath) {
    const packageFile = zip.file(packagePath);
    if (!packageFile) {
        throw new Error(`Package document was not found at ${packagePath}.`);
    }

    const packageXml = await packageFile.async("string");
    const packageDoc = parseXml(packageXml);

    const metadataElement = getFirstByLocalName(packageDoc, "metadata");
    const titleElement = metadataElement ? getFirstByLocalName(metadataElement, "title") : null;
    const authorElement = metadataElement ? getFirstByLocalName(metadataElement, "creator") : null;

    const manifestElement = getFirstByLocalName(packageDoc, "manifest");
    const manifestEntries = manifestElement ? getAllByLocalName(manifestElement, "item") : [];
    const manifestById = new Map(
        manifestEntries.map((item) => [item.getAttribute("id"), item.getAttribute("href")])
    );

    const spineElement = getFirstByLocalName(packageDoc, "spine");
    const itemRefs = spineElement ? getAllByLocalName(spineElement, "itemref") : [];
    const orderedChapterPaths = itemRefs
        .map((itemRef) => manifestById.get(itemRef.getAttribute("idref")))
        .filter(Boolean)
        .map((href) => resolveRelativePath(packagePath, href));

    return {
        title: titleElement ? titleElement.textContent.trim() : "",
        author: authorElement ? authorElement.textContent.trim() : "",
        chapterPaths: orderedChapterPaths,
    };
}

async function extractBookFromZip(zip) {
    const packagePath = await extractPackagePath(zip);
    const { title, author, chapterPaths } = await extractMetadataAndSpine(zip, packagePath);

    const paragraphs = [];

    for (const chapterPath of chapterPaths) {
        const chapterFile = zip.file(chapterPath);
        if (!chapterFile) {
            continue;
        }

        const chapterXml = await chapterFile.async("string");
        const chapterDocument = new DOMParser().parseFromString(chapterXml, "application/xhtml+xml");
        const chapterParagraphs = extractParagraphsFromDocument(chapterDocument);
        paragraphs.push(...chapterParagraphs);
    }

    paragraphs.forEach((paragraph, paragraphIndex) => {
        paragraph.words.forEach((word) => {
            word.paragraphIndex = paragraphIndex;
        });
    });

    return new Book(title, author, paragraphs);
}

export async function parseEpubFile(file) {
    const zip = await JSZip.loadAsync(file);
    return extractBookFromZip(zip);
}
