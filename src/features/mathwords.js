/*
 * Plain-English maths for Tahoe Math: "days until Oct 14 =" → the model
 * rewrites the question as one expression for Tahoe Math's calculator, which
 * does the arithmetic — so answers stay exact. Tahoe Math caches the rewrite in
 * its settings, so the answer shows on iPhone too.
 */

import { S } from "../engine";
import { longDate, isoDate } from "../vault";

function instructions(variables) {
  return `You turn a question written in words into ONE expression for a calculator. Reply with the expression only.
The calculator understands:
- numbers, + - * / ^ and parentheses; percentages like 20% and "20% of 80"
- units and conversions: "5 miles to km", "3 hours + 20 min", "70 kg to lb", "20 degC to degF", "1 week to seconds"
- money written with $ (or €, £)
- date functions — write dates or holidays the way the question does, in quotes:
  daysUntil("Oct 14"), daysSince("Sep 1"), daysBetween("Oct 1", "Oct 14"), weeksUntil("thanksgiving"), weekday("christmas"), dateOf("labor day"), dateIn(30)
${variables.length ? `- these variables from the note: ${variables.join(", ")}. When the question names one, use the variable, not a number.` : ""}
Examples:
"days until Oct 14" → daysUntil("Oct 14")
"20% tip on $86 split 3 ways" → $86 * 1.2 / 3
"how many seconds in a week" → 1 week to seconds
"what day is christmas" → weekday("christmas")
"split rent between 3 people", with a variable rent → rent / 3
Use only the numbers and dates in the question — never numbers from these examples.
If the question can't be worked out with this calculator (or needs a number it doesn't give), reply with an empty expression.
Today is ${longDate()} (${isoDate()}).`;
}

async function translateMath(plugin, question, { variables = [] } = {}) {
  const q = String(question || "").trim().slice(0, 200);
  if (!q) return null;
  const r = await plugin.engine.generate({
    instructions: instructions(variables.slice(0, 20)),
    prompt: `Question: ${q}`,
    schema: S.object({ expression: S.string("One calculator expression, or empty") }),
    temperature: 0,
  });
  const expr = String(r.expression || "").trim().replace(/=\s*$/, "").slice(0, 200);
  return expr || null;
}

export { translateMath };
