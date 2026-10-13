declare module 'foliate-js/view.js' {
  export function makeBook(file: File | Blob): Promise<any>;
}

declare module 'foliate-js/fb2.js' {
  export function makeFB2(blob: Blob): Promise<any>;
}

declare module 'foliate-js/epub.js' {
  export class EPUB {
    constructor(loader: any);
    init(): Promise<any>;
  }
}

declare module 'foliate-js/mobi.js' {
  export function isMOBI(file: Blob): Promise<boolean>;
  export class MOBI {
    constructor(options?: any);
    open(file: Blob): Promise<any>;
  }
}
