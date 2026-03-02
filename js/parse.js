export class ParsedTextNode{
    constructor(text, style, paragraphIndex){
        this.text = text;
        this.style = style;
        this.paragraphIndex = paragraphIndex;
    }
}

export class ParsedParagraph{
    constructor(textNodes){
        this.textNodes = textNodes;
    }
}