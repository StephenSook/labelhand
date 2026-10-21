// The model writes ranges as "1 PM–7 PM" or "10–12 mph". The page shows "to" instead of the en
// dash. Only a dash between two numbers or times changes, and the guard has already checked the
// original text, so no number, id or window is touched.
const RANGE = /(\d(?:\s?[AP]M)?)\s*–\s*(?=\d)/g;

export function plainRanges(text: string): string {
  return text.replace(RANGE, "$1 to ");
}
