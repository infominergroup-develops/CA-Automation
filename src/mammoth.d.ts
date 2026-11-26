// mammoth ships no types; this is the one call the file viewer makes.
declare module 'mammoth' {
  export function convertToHtml(input: { arrayBuffer: ArrayBuffer }): Promise<{ value: string }>;
}
