// Reads a workshop bill (photo or PDF) with Claude and returns form fields.
// Nothing is saved here: the office checks the fields in the form and saves.

import Anthropic from '@anthropic-ai/sdk';

const MODEL = 'claude-opus-5';
const IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/gif'];

const nullable = (type, extra = {}) => ({ anyOf: [{ type, ...extra }, { type: 'null' }] });

function billSchema(systems, kinds) {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['date_in', 'date_out', 'workshop', 'bill_no', 'kind', 'system', 'odometer_km',
      'problem_reported', 'root_cause', 'labour_cost', 'total_cost', 'parts', 'unclear'],
    properties: {
      date_in: { ...nullable('string', { format: 'date' }), description: 'Bill or job date' },
      date_out: { ...nullable('string', { format: 'date' }), description: 'Delivery date if shown' },
      workshop: nullable('string'),
      bill_no: nullable('string'),
      kind: nullable('string', { enum: kinds }),
      system: nullable('string', { enum: systems }),
      odometer_km: nullable('integer'),
      problem_reported: { ...nullable('string'), description: 'Complaint or reason, if written on the bill' },
      root_cause: { ...nullable('string'), description: "Mechanic's remarks or finding, if written" },
      labour_cost: nullable('number'),
      total_cost: { ...nullable('number'), description: 'Grand total in rupees' },
      parts: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['part_name', 'position', 'removed_part_no', 'fitted_part_no', 'part_cost'],
          properties: {
            part_name: { type: 'string', description: 'Standard name, e.g. "Front brake pads (set)"' },
            position: { ...nullable('string'), description: 'e.g. Front-left, Rear axle' },
            removed_part_no: nullable('string'),
            fitted_part_no: nullable('string'),
            part_cost: nullable('number'),
          },
        },
      },
      unclear: { type: 'array', items: { type: 'string' }, description: 'Field names you could not read confidently' },
    },
  };
}

export function createBillReader(apiKey) {
  if (!apiKey) return null;
  const client = new Anthropic({ apiKey });

  return async function readBill({ buffer, mimetype, systems, kinds, workshops, buses }) {
    const data = buffer.toString('base64');
    let fileBlock;
    if (mimetype === 'application/pdf') {
      fileBlock = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data } };
    } else if (IMAGE_TYPES.includes(mimetype)) {
      fileBlock = { type: 'image', source: { type: 'base64', media_type: mimetype, data } };
    } else {
      throw new UserError('AI can read JPG, PNG, WEBP, GIF or PDF bills.');
    }

    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      output_config: { effort: 'medium', format: { type: 'json_schema', schema: billSchema(systems, kinds) } },
      system: [
        'You read Indian vehicle workshop bills for a school transport office and extract fields for their bus maintenance log.',
        'Return null for anything not on the bill; never guess numbers. Amounts are rupees without symbols or commas.',
        'Write part names in plain standard English (e.g. "brk pad chngd" -> "Front brake pads (set)") and pick the vehicle system the work mostly concerns.',
        `Vehicle systems: ${systems.join(', ')}.`,
        `Known workshops (use the exact spelling if one matches): ${workshops.join(', ') || 'none yet'}.`,
        `School buses: ${buses.join(', ')}.`,
        'List any field you were unsure about in "unclear".',
      ].join('\n'),
      messages: [{ role: 'user', content: [fileBlock, { type: 'text', text: 'Extract the fields from this bill.' }] }],
    });

    if (response.stop_reason === 'refusal') throw new UserError('AI could not read this bill. Please type the details in.');
    if (response.stop_reason === 'max_tokens') throw new UserError('The bill was too long to read in one go. Please type the details in.');
    const text = response.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
    try {
      return JSON.parse(text);
    } catch {
      throw new UserError('AI returned something unexpected. Please try again or type the details in.');
    }
  };
}

export class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}
