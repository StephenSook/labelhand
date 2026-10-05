export type TextLayerItem = { str: string };

const OMITTED_GLYPHS = /[\s\uFFFD®™℠]/gu;

export function foldLabelText(value: string): string {
  return value.toLocaleLowerCase("en-US").replace(OMITTED_GLYPHS, "");
}

export function matchingTextItemIndexes(
  items: readonly TextLayerItem[],
  quote: string,
): number[] {
  const foldedQuote = foldLabelText(quote);
  if (!foldedQuote) return [];

  let foldedPage = "";
  const sourceItemByCharacter: number[] = [];
  items.forEach((item, itemIndex) => {
    for (const character of item.str) {
      const folded = foldLabelText(character);
      for (const outputCharacter of folded) {
        foldedPage += outputCharacter;
        sourceItemByCharacter.push(itemIndex);
      }
    }
  });

  const start = foldedPage.indexOf(foldedQuote);
  if (start < 0) return [];
  return [...new Set(sourceItemByCharacter.slice(start, start + foldedQuote.length))];
}
