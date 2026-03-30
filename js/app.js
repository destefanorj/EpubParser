import { parseEpubFile } from "./parse.js";

const dropZone = document.getElementById("dropZone");
const status = document.getElementById("status");
const output = document.getElementById("output");

function setBusy(isBusy) {
    dropZone.classList.toggle("busy", isBusy);
}

function formatWord(word) {
    return word.characters.map((character) => character.character).join("");
}

function renderBook(book) {
    output.textContent = JSON.stringify(
        {
            title: book.title,
            author: book.author,
            paragraphCount: book.paragraphs.length,
            preview: book.paragraphs.slice(0, 2).map((paragraph, paragraphIndex) => ({
                paragraphIndex,
                alignment: paragraph.alignment,
                words: paragraph.words.slice(0, 20).map((word) => formatWord(word)),
            })),
        },
        null,
        2
    );
}

function sanitizeFilenamePart(value) {
    return value
        .trim()
        .replace(/[\\/:*?"<>|]/g, "")
        .replace(/\s+/g, " ")
        .slice(0, 120);
}

function getBookJsonFilename(book, sourceFilename) {
    const sourceNameWithoutExt = sourceFilename.replace(/\.[^.]+$/, "");
    const preferredName = sanitizeFilenamePart(book.title || "");
    const fallbackName = sanitizeFilenamePart(sourceNameWithoutExt || "book");
    return `${preferredName || fallbackName || "book"}.json`;
}

function downloadBookJson(book, sourceFilename) {
    const jsonContent = JSON.stringify(book, null, 2);
    const blob = new Blob([jsonContent], { type: "application/json" });
    const url = URL.createObjectURL(blob);

    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = getBookJsonFilename(book, sourceFilename);
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);

    URL.revokeObjectURL(url);
}

async function handleFile(file) {
    if (!file || !file.name.toLowerCase().endsWith(".epub")) {
        status.textContent = "Please drop a valid .epub file.";
        return;
    }

    setBusy(true);
    status.textContent = `Parsing ${file.name}...`;

    try {
        const book = await parseEpubFile(file);
        downloadBookJson(book, file.name);
        status.textContent = `Parsed “${book.title || file.name}” by ${book.author || "Unknown author"}. Downloaded JSON.`;
        renderBook(book);
        window.latestParsedBook = book;
    } catch (error) {
        status.textContent = `Failed to parse EPUB: ${error.message}`;
        output.textContent = "";
    } finally {
        setBusy(false);
    }
}

function preventDefaults(event) {
    event.preventDefault();
    event.stopPropagation();
}

["dragenter", "dragover", "dragleave", "drop"].forEach((eventName) => {
    dropZone.addEventListener(eventName, preventDefaults, false);
});

["dragenter", "dragover"].forEach((eventName) => {
    dropZone.addEventListener(eventName, () => dropZone.classList.add("hover"), false);
});

["dragleave", "drop"].forEach((eventName) => {
    dropZone.addEventListener(eventName, () => dropZone.classList.remove("hover"), false);
});

dropZone.addEventListener("drop", (event) => {
    const [file] = event.dataTransfer.files;
    handleFile(file);
});

dropZone.addEventListener("click", () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".epub";

    input.addEventListener("change", () => {
        const [file] = input.files;
        handleFile(file);
    });

    input.click();
});
