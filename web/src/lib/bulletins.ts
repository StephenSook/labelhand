// EPA's Bulletins Live! Two, the map of Endangered Species Protection Bulletins. This is the app
// that https://www.epa.gov/endangered-species/bulletins-live-two-view-bulletins embeds.
export const BULLETINS_LIVE_TWO_URL = "https://blt.epa.gov/blt/public";

// The map's Location Search reads "latitude, longitude" (31.4, -83.6 put the result pin on Tift).
export function bulletinCoordinates(lat: number, lon: number): string {
  const format = (value: number) => String(Number(value.toFixed(4)));
  return `${format(lat)}, ${format(lon)}`;
}
