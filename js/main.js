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

function detectFileType(file){
    const name = file.name.toLowerCase();

    if(name.endsWith(".epub")) return "epub";
    if(name.endsWith(".json")) return "msdf-json";

    return "unknown";
}

async function handleAsset(file) {
    const type = detectFileType(file);

    switch (type) {
        case "epub":
            return await handleEpub(file);

        case "msdf-json":
            return await handleMsdfJson(file);

        default:
            console.warn("Unsupported file type:", file.name);
            alert("Unsupported file type");
    }
}

//Handle file drop
dropZone.addEventListener("drop", async(e) => {
    const files = e.dataTransfer.files;

    if(files.length === 0) return;

    const file = files[0];

    console.log("Dropped file:", file.name);

    await handleAsset(file);
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
    const metadataNode = opfDoc.querySelector("metadata");

    const metadataResult = {
        title: "book",
        creator: "unknown",
        publisher: null,
        date: null,
        language: null,
        identifier: null,
        description: null,
        subject: []
    };

    function getText(node, selectors) {
        for (const sel of selectors) {
            const el = node.querySelector(sel);
            if (el && el.textContent) {
                return el.textContent.trim();
            }
        }
        return null;
    }

    if (metadataNode) {
        metadataResult.title = getText(metadataNode, ["title", "dc\\:title"]) || "book";
        metadataResult.creator = getText(metadataNode, ["creator", "dc\\:creator"]) || "unknown";
        metadataResult.publisher = getText(metadataNode, ["publisher", "dc\\:publisher"]);
        metadataResult.date = getText(metadataNode, ["date", "dc\\:date"]);
        metadataResult.language = getText(metadataNode, ["language", "dc\\:language"]);
        metadataResult.identifier = getText(metadataNode, ["identifier", "dc\\:identifier"]);
        metadataResult.description = getText(metadataNode, ["description", "dc\\:description"]);

        metadataNode.querySelectorAll("subject, dc\\:subject").forEach(el => {
            const val = el.textContent.trim();
            if (val) metadataResult.subject.push(val);
        });
    }

    console.log("Metadata:", metadataResult);

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
    result.metadata = metadataResult;

    console.log("Paragraphs:", result.paragraphs.length);
    console.log("Spans:", result.spans.length);
    console.log("Text length:", result.text.length);
    console.log("Styles:", result.styles);

    console.log("Preview:", result.text.substring(0, 500));

    const buffer = writeBardo(result);
    verifyBardo(buffer);

    const safeTitle = sanitizeFilename(result.metadata?.title || "book");
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

    // Build metadata buffer

    function buildMetadataBuffer(metadata){
        const fields = [];

        function add(type, value){
            if(value && value.length > 0){
                const bytes = encoder.encode(value);
                fields.push({type, bytes});
            }
        }

        // Field types
        add(1, metadata?.title);
        add(2, metadata?.creator);
        add(3, metadata?.publisher);
        add(4, metadata?.date);
        add(5, metadata?.language);
        add(6, metadata?.identifier);
        add(7, metadata?.description);

        if (metadata?.subject) {
            for (const s of metadata.subject) {
                add(8, s);
            }
        }

        let size = 2;   // field count

        for(const f of fields){
            size += 1 + 4 + f.bytes.length;
        }

        const buffer = new ArrayBuffer(size);
        const view = new DataView(buffer);

        let offset = 0;

        view.setUint16(offset, fields.length, true);
        offset += 2;

        for (const f of fields) {
            view.setUint8(offset, f.type); offset += 1;
            view.setUint32(offset, f.bytes.length, true); offset += 4;

            new Uint8Array(buffer, offset, f.bytes.length).set(f.bytes);
            offset += f.bytes.length;
        }

        return buffer;
    }

    const metadataBuffer = buildMetadataBuffer(result.metadata || {});
    const metadataSize = metadataBuffer.byteLength;

    // ---- Layout constants (must match loader later) ----
    const HEADER_SIZE = 48;
    const STYLE_SIZE = 4;
    const PARAGRAPH_SIZE = 12;
    const SPAN_SIZE = 12;

    const styleCount = result.styles.length;
    const paragraphCount = result.paragraphs.length;
    const spanCount = result.spans.length;
    const textSize = textBytes.length;

    // Offsets

    const metadataOffset = HEADER_SIZE;

    const styleOffset = metadataOffset + metadataSize;
    const paragraphOffset = styleOffset + styleCount * STYLE_SIZE;
    const spanOffset = paragraphOffset + paragraphCount * PARAGRAPH_SIZE;
    const textOffset = spanOffset + spanCount * SPAN_SIZE;

    const bufferSize =
        HEADER_SIZE +
        metadataSize +
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

    view.setUint32(offset, metadataSize, true);
    offset += 4;

    view.setUint32(offset, styleOffset, true); offset += 4;
    view.setUint32(offset, paragraphOffset, true); offset += 4;
    view.setUint32(offset, spanOffset, true); offset += 4;
    view.setUint32(offset, textOffset, true); offset += 4;
    view.setUint32(offset, metadataOffset, true); offset += 4;

    // Metadata
    new Uint8Array(buffer, metadataOffset).set(new Uint8Array(metadataBuffer));

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

//---------------------------//
//---------MSDF JSON---------//
//---------------------------//

class BinaryWriter{
    constructor(initialSize = 1024 * 1024){
        this.buffer = new ArrayBuffer(initialSize);
        this.view = new DataView(this.buffer);
        this.offset = 0;
    }

    ensure(size){
        if(this.offset + size < this.buffer.byteLength) return;

        let newSize = this.buffer.byteLength * 2;
        while(newSize < this.offset + size){
            newSize *= 2;
        }

        const newBuffer = new ArrayBuffer(newSize);
        new Uint8Array(newBuffer).set(new Uint8Array(this.buffer));
        this.buffer = newBuffer;
        this.view = new DataView(this.buffer);
    }

    writeUint8(v){
        this.ensure(1);
        this.view.setUint8(this.offset, v);
        this.offset += 1;
    }

    writeUint32(v){
        this.ensure(4);
        this.view.setUint32(this.offset, v, true);
        this.offset += 4;
    }

    writeFloat32(v){
        this.ensure(4);
        this.view.setFloat32(this.offset, v, true);
        this.offset += 4;
    }
}

async function convertMsdfJsonToBinary(file){
    const text = await file.text();
    const data = JSON.parse(text);

    const writer = new BinaryWriter();

    // Header
    writer.writeUint32(0x4D534446); //MSDF
    writer.writeUint32(1);          //version

    const glyphs = data.glyphs;
    const kerning = data.kerning || [];

    writer.writeUint32(glyphs.length);
    writer.writeUint32(kerning.length);

    // Atlas metadata
    const atlas = data.atlas;

    writer.writeUint32(atlas.width);
    writer.writeUint32(atlas.height);
    writer.writeFloat32(atlas.distanceRange);

    // Glyphs
    for (let g of glyphs) {
        writer.writeUint32(g.unicode);
        writer.writeFloat32(g.advance);

        // detect glyph type
        let flags = 0;

        const hasPlane = g.planeBounds != null;
        const hasAtlas = g.atlasBounds != null;

        // whitespace (space, NBSP, tab-like glyphs)
        if (!hasAtlas && g.advance > 0) {
            flags = 1;
        }

        // missing glyph (no geometry AND no meaningful advance fallback)
        if (!hasAtlas && !hasPlane) {
            flags = 2;
        }

        writer.writeUint8(flags);

        // always write bounds (even if zeroed)
        writeBounds(writer, g.planeBounds);
        writeNormalizedAtlasBounds(
            writer,
            g.atlasBounds,
            atlas.width,
            atlas.height
        );
    }

    // Kerning
    for (let k of kerning) {
        writer.writeUint32(k.first);
        writer.writeUint32(k.second);
        writer.writeFloat32(k.amount);
    }

    // trim buffer
    return writer.buffer.slice(0, writer.offset);
}

async function handleMsdfJson(file){
    const binary = await convertMsdfJsonToBinary(file);

    const blob = new Blob([binary], {type: "application/octet-stream"});

    const url = URL.createObjectURL(blob);

    console.log("MSDF binary generated:", url);

    // optional: trigger download for debugging
    const a = document.createElement("a");
    a.href = url;
    a.download = file.name.replace(".json", ".msdfb");
    a.click();
}

function writeBounds(writer, b) {
    if (!b) {
        writer.writeFloat32(0);
        writer.writeFloat32(0);
        writer.writeFloat32(0);
        writer.writeFloat32(0);
        return;
    }

    writer.writeFloat32(b.left);
    writer.writeFloat32(b.bottom);
    writer.writeFloat32(b.right);
    writer.writeFloat32(b.top);
}

function writeNormalizedAtlasBounds(writer, b, atlasWidth, atlasHeight) {
    if (!b) {
        writer.writeFloat32(0);
        writer.writeFloat32(0);
        writer.writeFloat32(0);
        writer.writeFloat32(0);
        return;
    }

    const left   = b.left   / atlasWidth;
    const right  = b.right  / atlasWidth;

    // Flip Y
    const top    = 1.0 - (b.top    / atlasHeight);
    const bottom = 1.0 - (b.bottom / atlasHeight);

    writer.writeFloat32(left);
    writer.writeFloat32(bottom);
    writer.writeFloat32(right);
    writer.writeFloat32(top);
}