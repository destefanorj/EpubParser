const dropZone = document.getElementById("dropZone");

//Prevent browser from opening file
["dragenter", "dragover", "dragleave", "drop"].forEach(eventName=> {
    dropZone.addEventListener(eventName, e=>e.preventDefault());
    dropZone.addEventListener(eventName, e=>e.stopPropagation());
});

//Visual feedback
["dragenter", "dragover"].forEach(eventName=>{
    dropZone.addEventListener(eventName, ()=>{
        dropZone.style.background = "#ddd";
    });
});

["dragleave", "drop"].forEach(eventName => {
    dropZone.addEventListener(eventName, () => {
        dropZone.style.background = "";
    });
});

//Handle file drop
dropZone.addEventListener("drop", async(e) => {
    const files = e.dataTransfer.files;

    if(files.length === 0) return;

    const file = files[0];

    if(!file.name.endsWith(".epub")){
        alert("Please drop a valid EPUB file.");
        return;
    }

    console.log("Loaded EPUB: ", file.name);

    await handleEpub(file);
});

async function handleEpub(file){
    console.log("Parsing epub...");

    const zip = await JSZip.loadAsync(file);

    //load container.xml
    const containerFile = zip.file("META-INF/container.xml");

    if(!containerFile){
        throw new Error("Invalid EPUB: container.xml not found");
    }

    const containerText = await containerFile.async("string");

    console.log("container.xml loaded");

    //parse xml
    const parser = new DOMParser();
    const containerDoc = parser.parseFromString(containerText, "application/xml");

    //extract opf path
    const rootFile = containerDoc.querySelector("rootfile");

    if(!rootFile){
        throw new Error("Invalid EPUB: rootfile not found");
    }

    const opfPath = rootFile.getAttribute("full-path");

    const opfFile = zip.file(opfPath);

    if(!opfFile){
        throw new Error("OPF file not found: " + opfPath);
    }

    const opfText = await opfFile.async("string");

    console.log("OPF loaded");

    //parse opf text
    const opfParser = new DOMParser();
    const opfDoc = opfParser.parseFromString(opfText, "application/xml");

    let title = "book";
    let author = "unknown";

    // EPUB metadata lives here
    const metadata = opfDoc.querySelector("metadata");

    if (metadata) {
        const titleNode =
            metadata.querySelector("title") ||
            metadata.querySelector("dc\\:title");

        const authorNode =
            metadata.querySelector("creator") ||
            metadata.querySelector("dc\\:creator");

        if (titleNode) title = titleNode.textContent.trim();
        if (authorNode) author = authorNode.textContent.trim();
    }

    console.log("Title:", title);
    console.log("Author:", author);

    //get manifest
    const manifest = {};

    opfDoc.querySelectorAll("manifest item").forEach(item => {
        const id = item.getAttribute("id");
        const href = item.getAttribute("href");

        manifest[id] = href;
    });

    console.log("Manifest:", manifest);

    const spine = [];

    opfDoc.querySelectorAll("spine itemref").forEach(itemref => {
        const idref = itemref.getAttribute("idref");
        const href = manifest[idref];

        if (href) {
            spine.push(href);
        }
    });

    console.log("Spine:", spine);

    if (spine.length === 0) {
        throw new Error("Spine is empty");
    }

    // Find first VALID chapter
    const opfDir = opfPath.substring(0, opfPath.lastIndexOf("/") + 1);

    let chapterDoc = null;

    for (let i = 0; i < spine.length; i++) {
        const path = opfDir + spine[i];
        const file = zip.file(path);
        if (!file) continue;

        const text = await file.async("string");

        const doc = parser.parseFromString(text, "text/html");

        // Check if it has actual text
        if (doc.body && doc.body.textContent.trim().length > 0) {
            chapterDoc = doc;
            console.log("Using chapter:", path);
            break;
        }
    }

    if (!chapterDoc) {
        throw new Error("No valid chapter found");
    }

    const result = buildBardoFromDocument(chapterDoc);
    result.title = title;
    result.author = author;

    console.log("Paragraphs:", result.paragraphs.length);
    console.log("Spans:", result.spans.length);
    console.log("Text length:", result.text.length);
    console.log("Styles:", result.styles);

    console.log("Preview:", result.text.substring(0, 500));

    const buffer = writeBardo(result);
    verifyBardo(buffer);

    const safeTitle = sanitizeFilename(result.title || "book");
    downloadBardo(buffer, safeTitle);
}

function buildBardoFromDocument(doc) {

    let fullText = "";
    const spans = [];
    const paragraphs = [];
    const styles = [{flags: 0}];

    let currentParagraph = null;

    function startParagraph() {
        currentParagraph = {
            spanStart: spans.length,
            spanCount: 0,
            alignment: 0
        };
        paragraphs.push(currentParagraph);
    }

    function addSpan(text, styleIndex) {
        const offset = fullText.length;

        fullText += text;

        spans.push({
            textOffset: offset,
            textLength: text.length,
            styleIndex: styleIndex
        });

        if (currentParagraph) {
            currentParagraph.spanCount++;
        }
    }

    function isParagraphElement(node) {
        if (!node || node.nodeType !== 1) return false;

        const tag = node.tagName.toLowerCase();

        return ["p", "h1", "h2", "h3", "h4", "h5", "h6"].includes(tag);
    }

    function getStyleIndex(node){
        let isBold = false;
        let isItalic = false;

        let current = node.parentNode;
        
        while(current && current.nodeType === 1){
            const tag = current.tagName.toLowerCase();

            if(tag === "b" || tag === "strong") isBold = true;
            if(tag === "i" || tag === "em") isItalic = true;

            current = current.parentNode;
        }

        const flags = (isBold ? 1 : 0) | (isItalic ? 2 : 0);

        //check if style already exists
        let index = styles.findIndex(s=> s.flags === flags);

        if(index === -1) {
            styles.push({flags});
            index = styles.length - 1;
        }

        return index;
    }

    const walker = document.createTreeWalker(
        doc.body,
        NodeFilter.SHOW_TEXT,
        null
    );

    let node;

    let lastParagraphElement = null;

    while (node = walker.nextNode()) {

        let text = node.nodeValue;
        if (!text) continue;

        text = text.replace(/\s+/g, " ").trim();
        if (text.length === 0) continue;

        // Find nearest block-level ancestor
        let parent = node.parentNode;
        while (parent && parent !== doc.body && !isParagraphElement(parent)) {
            parent = parent.parentNode;
        }

        // Start paragraph ONLY when block changes
        if (parent !== lastParagraphElement) {
            startParagraph();
            lastParagraphElement = parent;
        }

        // Add spacing
        if (fullText.length > 0 && !fullText.endsWith(" ")) {
            fullText += " ";
        }

        const styleIndex = getStyleIndex(node);
        addSpan(text, styleIndex);
    }

    return {
        text: fullText,
        spans,
        paragraphs,
        styles
    };
}

function downloadBardo(buffer, title) {
    const blob = new Blob([buffer], { type: "application/octet-stream" });
    const url = URL.createObjectURL(blob);

    const a = document.createElement("a");
    a.href = url;
    a.download = `${title}.bardo`;
    a.click();

    URL.revokeObjectURL(url);
}

function writeBardo(result) {

    const encoder = new TextEncoder();
    const textBytes = encoder.encode(result.text);

    // ---- Layout constants (must match loader later) ----
    const HEADER_SIZE = 32;
    const STYLE_SIZE = 4;
    const PARAGRAPH_SIZE = 12;
    const SPAN_SIZE = 12;

    const styleCount = result.styles.length;
    const paragraphCount = result.paragraphs.length;
    const spanCount = result.spans.length;
    const textSize = textBytes.length;

    const bufferSize =
        HEADER_SIZE +
        (styleCount * STYLE_SIZE) +
        (paragraphCount * PARAGRAPH_SIZE) +
        (spanCount * SPAN_SIZE) +
        textSize;

    const buffer = new ArrayBuffer(bufferSize);
    const view = new DataView(buffer);

    let offset = 0;

    // =========================
    // HEADER
    // =========================

    view.setUint32(offset, 0x42415244, true); // 'BRDO'
    offset += 4;

    view.setUint16(offset, 1, true); // version
    offset += 2;

    view.setUint16(offset, 0, true); // reserved
    offset += 2;

    view.setUint32(offset, styleCount, true);
    offset += 4;

    view.setUint32(offset, paragraphCount, true);
    offset += 4;

    view.setUint32(offset, spanCount, true);
    offset += 4;

    view.setUint32(offset, textSize, true);
    offset += 4;

    const styleOffset = HEADER_SIZE;
    const paragraphOffset = styleOffset + styleCount * STYLE_SIZE;
    const spanOffset = paragraphOffset + paragraphCount * PARAGRAPH_SIZE;
    const textOffset = spanOffset + spanCount * SPAN_SIZE;

    view.setUint32(offset, styleOffset, true); offset += 4;
    view.setUint32(offset, paragraphOffset, true); offset += 4;
    view.setUint32(offset, spanOffset, true); offset += 4;
    view.setUint32(offset, textOffset, true); offset += 4;

    // =========================
    // STYLES
    // =========================

    let ptr = styleOffset;

    for (const s of result.styles) {
        view.setUint8(ptr, s.flags);
        ptr += 1;

        // padding (3 bytes)
        view.setUint8(ptr, 0); ptr++;
        view.setUint8(ptr, 0); ptr++;
        view.setUint8(ptr, 0); ptr++;
    }

    // =========================
    // PARAGRAPHS
    // =========================

    ptr = paragraphOffset;

    for (const p of result.paragraphs) {
        view.setUint32(ptr, p.spanStart, true); ptr += 4;
        view.setUint32(ptr, p.spanCount, true); ptr += 4;
        view.setUint8(ptr, p.alignment); ptr += 1;

        // padding
        view.setUint8(ptr, 0); ptr++;
        view.setUint8(ptr, 0); ptr++;
        view.setUint8(ptr, 0); ptr++;
    }

    // =========================
    // SPANS
    // =========================

    ptr = spanOffset;

    for (const s of result.spans) {
        view.setUint32(ptr, s.textOffset, true); ptr += 4;
        view.setUint32(ptr, s.textLength, true); ptr += 4;
        view.setUint16(ptr, s.styleIndex, true); ptr += 2;

        // padding
        view.setUint16(ptr, 0, true); ptr += 2;
    }

    // =========================
    // TEXT BLOB
    // =========================

    new Uint8Array(buffer, textOffset).set(textBytes);

    return buffer;
}

function verifyBardo(buffer) {
    const view = new DataView(buffer);

    let offset = 0;

    // -----------------------------
    // HEADER
    // -----------------------------
    const magic = view.getUint32(offset, true);
    offset += 4;

    const expectedMagic = 0x42415244; // 'BRDO'

    if (magic !== expectedMagic) {
        throw new Error("Invalid magic number (not a .bardo file)");
    }

    const version = view.getUint16(offset, true);
    offset += 2;

    const reserved = view.getUint16(offset, true);
    offset += 2;

    const styleCount = view.getUint32(offset, true);
    offset += 4;

    const paragraphCount = view.getUint32(offset, true);
    offset += 4;

    const spanCount = view.getUint32(offset, true);
    offset += 4;

    const textSize = view.getUint32(offset, true);
    offset += 4;

    const styleOffset = view.getUint32(offset, true);
    offset += 4;

    const paragraphOffset = view.getUint32(offset, true);
    offset += 4;

    const spanOffset = view.getUint32(offset, true);
    offset += 4;

    const textOffset = view.getUint32(offset, true);
    offset += 4;

    console.log("---- BARD0 VERIFY ----");
    console.log("Version:", version);
    console.log("Styles:", styleCount);
    console.log("Paragraphs:", paragraphCount);
    console.log("Spans:", spanCount);
    console.log("Text size:", textSize);

    // -----------------------------
    // BASIC CONSISTENCY CHECKS
    // -----------------------------

    if (styleCount < 1) throw new Error("No styles found");
    if (paragraphCount === 0) throw new Error("No paragraphs found");
    if (spanCount === 0) throw new Error("No spans found");
    if (textSize === 0) throw new Error("No text found");

    // -----------------------------
    // BOUNDS CHECK
    // -----------------------------
    const totalSize = buffer.byteLength;

    const endOfStyles = styleOffset + styleCount * 4;
    const endOfParagraphs = paragraphOffset + paragraphCount * 12;
    const endOfSpans = spanOffset + spanCount * 12;
    const endOfText = textOffset + textSize;

    if (endOfStyles > totalSize) throw new Error("Style section out of bounds");
    if (endOfParagraphs > totalSize) throw new Error("Paragraph section out of bounds");
    if (endOfSpans > totalSize) throw new Error("Span section out of bounds");
    if (endOfText > totalSize) throw new Error("Text section out of bounds");

    // -----------------------------
    // OPTIONAL: sanity check text
    // -----------------------------
    const textBytes = new Uint8Array(buffer, textOffset, Math.min(textSize, 200));
    const preview = new TextDecoder().decode(textBytes);

    console.log("Text preview:", preview);

    console.log("---- VERIFY OK ----");

    return true;
}

function sanitizeFilename(name) {
    return name
        .replace(/[\\/:*?"<>|]/g, "")
        .replace(/\s+/g, " ")
        .trim();
}