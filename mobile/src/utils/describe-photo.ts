// Turns a report photo into a suggested caption. Returns null if no description could be generated.
export async function describePhoto(photoUri: string): Promise<string | null> {
  // TODO: send the photo to a vision model (e.g. read it as base64 with expo-file-system, POST it to our
  // backend, which calls the model) and return its short description of the waste problem.
  console.log("describePhoto not implemented yet", photoUri);
  return null;
}
