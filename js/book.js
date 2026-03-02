export class Book{
    constructor(title, author, paragraphs){
        this.title = title;
        this.author = author;
        this.paragraphs = paragraphs;
    }
}

class Paragraph{
    constructor(alignment = "left", words){
        this.alignment = alignment;
        this.words = words;
    }
}

class Word{
    constructor(characters){
        this.characters = characters;
    }
}

class Character{
    constructor(character, bold = false, italic = false, underline = false){
        this.character = character;
        this.bold = bold;
        this.italic = italic;
        this.underline = underline;
    }
}