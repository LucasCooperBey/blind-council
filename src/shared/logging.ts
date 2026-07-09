export function log(agent: string, level: "info" | "warn" | "error", message: string, data?: Record<string, unknown>): void {
  const entry = {
    timestamp: new Date().toISOString(),
    agent,
    level,
    message,
    ...data,
  };
  console.log(JSON.stringify(entry));
}
