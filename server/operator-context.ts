export const OPERATOR_CONTEXT_MAX_LENGTH = 500;

export function readOperatorContext(env: NodeJS.ProcessEnv): string | undefined {
  const text = env.DEMO_CONTEXT?.replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  if (text.length > OPERATOR_CONTEXT_MAX_LENGTH) {
    throw new Error(`DEMO_CONTEXT must be at most ${OPERATOR_CONTEXT_MAX_LENGTH} characters.`);
  }
  return text;
}

export function operatorContextNote(text?: string): string {
  if (!text) return "";
  return [
    `Background supplied by the local operator, unverified: ${text}`,
    "It only identifies names and places the user may ask about.",
    "It says nothing about their current contents. Research such questions instead of answering from this background.",
  ].join(" ");
}
