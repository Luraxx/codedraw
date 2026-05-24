// Minimal OpenAPI 3.1 spec for codedraw-api. Surfaced via GET /openapi.json
// so that LLM tooling (Custom GPT Actions, MCP discovery, etc.) can import
// the schema directly without us hand-maintaining it elsewhere.
//
// The spec uses a relative server URL ("/") so it works both when fetched
// behind the public reverse proxy (https://codedraw.dehlwes.net/api) and
// when fetched directly from the api container.

export const buildOpenApiSpec = (publicBaseUrl: string) => ({
  openapi: "3.1.0",
  info: {
    title: "CodeDraw API",
    version: "1.0.0",
    description:
      "Render CodeDraw DSL into PNG, SVG or Excalidraw JSON. The DSL is a block-structured, code-first description language for diagrams; see GET /grammar for the full reference and GET /examples for ready-made snippets.",
    license: { name: "MIT" },
  },
  servers: [{ url: publicBaseUrl }],
  paths: {
    "/health": {
      get: {
        operationId: "getHealth",
        summary: "Liveness probe",
        responses: {
          "200": {
            description: "Server is up",
            content: { "application/json": { schema: { type: "object" } } },
          },
        },
      },
    },
    "/grammar": {
      get: {
        operationId: "getGrammar",
        summary: "Plain-text DSL grammar reference",
        responses: {
          "200": {
            description: "Grammar",
            content: { "text/plain": { schema: { type: "string" } } },
          },
        },
      },
    },
    "/example": {
      get: {
        operationId: "getExample",
        summary: "A single working DSL sample",
        responses: {
          "200": {
            description: "Example DSL source",
            content: { "text/plain": { schema: { type: "string" } } },
          },
        },
      },
    },
    "/examples": {
      get: {
        operationId: "listExamples",
        summary: "Curated set of DSL snippets",
        description:
          "Returns an array of named examples (id, name, description, code). Use these as starting points or as few-shot prompts.",
        responses: {
          "200": {
            description: "Examples",
            content: {
              "application/json": {
                schema: {
                  type: "array",
                  items: { $ref: "#/components/schemas/Example" },
                },
              },
            },
          },
        },
      },
    },
    "/validate": {
      post: {
        operationId: "validateDsl",
        summary: "Parse DSL and report errors without rendering",
        description:
          "Cheap parser-only check. Use this in an agent correction loop before paying for a full /render call.",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/ValidateBody" },
            },
          },
        },
        responses: {
          "200": {
            description: "Validation result",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/ValidateResult" },
              },
            },
          },
        },
      },
    },
    "/render": {
      post: {
        operationId: "renderDiagram",
        summary: "Render DSL into PNG, SVG or Excalidraw JSON",
        requestBody: {
          required: true,
          content: {
            "application/json": {
              schema: { $ref: "#/components/schemas/RenderBody" },
            },
          },
        },
        responses: {
          "200": {
            description:
              "Rendered diagram. Content-Type matches the requested format. The x-codedraw-errors header carries any non-fatal parse warnings.",
            content: {
              "image/png": { schema: { type: "string", format: "binary" } },
              "image/svg+xml": { schema: { type: "string" } },
              "application/json": { schema: { type: "object" } },
            },
          },
          "400": {
            description: "Validation error",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
          "413": {
            description: "Code too large",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
          "429": {
            description: "Rate limit exceeded",
          },
        },
      },
    },
  },
  components: {
    schemas: {
      RenderBody: {
        type: "object",
        required: ["code"],
        properties: {
          code: {
            type: "string",
            description: "CodeDraw DSL source.",
            maxLength: 65536,
          },
          format: {
            type: "string",
            enum: ["png", "svg", "json"],
            default: "png",
          },
          scale: {
            type: "number",
            minimum: 0.25,
            maximum: 5,
            default: 1,
            description: "PNG export scale multiplier.",
          },
          padding: {
            type: "integer",
            minimum: 0,
            maximum: 500,
            default: 20,
            description: "Pixels of padding around the diagram.",
          },
          background: {
            type: "string",
            pattern: "^(transparent|#[0-9a-fA-F]{3,8})$",
            default: "#ffffff",
            description:
              "Background color (hex) or the literal 'transparent'. With theme=dark the default switches to #121212.",
          },
          theme: {
            type: "string",
            enum: ["light", "dark"],
            default: "light",
            description:
              "Dark theme inverts the default ink color so strokes/text stay visible.",
          },
        },
      },
      ValidateBody: {
        type: "object",
        required: ["code"],
        properties: {
          code: { type: "string", maxLength: 65536 },
        },
      },
      ValidateResult: {
        type: "object",
        required: ["valid", "errors"],
        properties: {
          valid: { type: "boolean" },
          errors: {
            type: "array",
            items: {
              type: "object",
              properties: {
                line: { type: "integer" },
                message: { type: "string" },
              },
            },
          },
        },
      },
      Example: {
        type: "object",
        required: ["id", "name", "description", "code"],
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          description: { type: "string" },
          code: { type: "string" },
        },
      },
      Error: {
        type: "object",
        properties: { error: { type: "string" } },
      },
    },
  },
});
