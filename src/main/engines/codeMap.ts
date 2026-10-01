// The code-map test (scripts/code-map): a new chat can start with a map of
// the project's code in front of its first message. Every engine gets the
// same text, so the test compares assistants and not wrappers.
export function withCodeMap(map: string, prompt: string): string {
  const note =
    "[Note from the app: below is a map of this project's code: its source files with their main functions and classes, the most used first. It was made before this chat started and leaves out what did not fit. Read the code itself before you rely on it.]";
  return `${note}\n\n${map.trim()}\n\n---\n\nMy message:\n${prompt}`;
}
