export class Book {
    constructor(title = "", author = "", paragraphs = []) {
        this.title = title;
        this.author = author;
        this.paragraphs = paragraphs;
    }
}

export class Paragraph {
    constructor(alignment = "left", words = []) {
        this.alignment = alignment;
        this.words = words;
    }
}

export class Word {
    constructor(characters = [], paragraphIndex = -1) {
        this.characters = characters;
        this.paragraphIndex = paragraphIndex;
    }
}

export class Character {
    constructor(character, bold = false, italic = false, underline = false) {
        this.character = character;
        this.bold = bold;
        this.italic = italic;
        this.underline = underline;
    }
}
