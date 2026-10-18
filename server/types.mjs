// Типы, которые код бота ожидает от платформенного sdk.
export class BotApiError extends Error {
  constructor(code, description, method, parameters) {
    super(description);
    this.code = code; this.description = description; this.method = method; this.parameters = parameters;
  }
}
export class EndpointError extends Error {
  constructor(description, parameters) {
    super(description);
    this.description = description; this.parameters = parameters; this.isEndpointError = true;
  }
}
export class InputFile { constructor(bytes, name, opts) { this.bytes = bytes; this.name = name; this.type = opts?.type; } }
