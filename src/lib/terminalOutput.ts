export function shouldAcceptTerminalOutput(input: {
  eventSessionId: string;
  activeSessionId: string | null;
  eventGeneration: number;
  activeGeneration: number;
}): boolean {
  return (
    input.activeSessionId === input.eventSessionId &&
    input.eventGeneration === input.activeGeneration
  );
}
