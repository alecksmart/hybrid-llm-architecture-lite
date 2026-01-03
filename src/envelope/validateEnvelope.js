const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const schema = require("./cloudEnvelope.schema.json");

const ajv = new Ajv({ allErrors: true, strict: true });
addFormats(ajv);

const validate = ajv.compile(schema);

function validateEnvelope(envelope) {
  const valid = validate(envelope);
  if (!valid) {
    const error = new Error("Envelope validation failed");
    error.details = validate.errors;
    throw error;
  }
  return true;
}

module.exports = { validateEnvelope };

