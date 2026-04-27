/**
 * MRA Scenario Tests — Real Marketing Plan GPT prompts
 * Tests classification only (no live API calls)
 * Run: node test/scenarios.js
 */

const { classifyIntent, detectMode, detectPlanType, extractServiceLines, buildSystemPrompt } = require('../server');
const assert = require('assert');

let passed = 0, failed = 0;

function test(name, fn) {
  try { fn(); passed++; console.log(`  \u2713 ${name}`); }
  catch (err) { failed++; console.log(`  \u2717 ${name}\n    ${err.message}`); }
}

console.log('\n\u2500\u2500 Scenario Tests: Real Marketing Plan GPT Prompts \u2500\u2500\u2500\u2500\u2500\n');

// ── Scenario 1: Section 5 demographics (facility opening) ──────
test('S1: Section 5 facility opening → demographics + psychographic, NOT locations', () => {
  const q = 'For Section 5 of the marketing plan. Facility Opening: Multi-Specialty Medical Center at 18503 Pines Blvd, Pembroke Pines FL 33029. Target: Commercially insured adults 25-64. Full demographic and psychographic analysis for ZIPs 33027, 33028, 33029. Full data.';
  assert.strictEqual(detectMode(q), 'marketing_plan');
  assert.strictEqual(detectPlanType(q), 'facility_opening');
  const intents = classifyIntent(q);
  assert.ok(intents.includes('demographics'), 'Should include demographics');
  assert.ok(intents.includes('psychographic'), 'Should include psychographic');
  assert.ok(!intents.includes('locations'), 'Should NOT include locations');
  assert.ok(!intents.includes('competitive'), 'Should NOT include competitive');
});

// ── Scenario 2: Section 4 competitive (multi-specialty, 5 service lines) ──
test('S2: Section 4 multi-specialty competitive → competitive + locations, extracts 5 service lines, NOT psychographic', () => {
  const q = 'For Section 4 of the marketing plan. Facility Opening: Multi-Specialty Medical Center at 18503 Pines Blvd, Pembroke Pines FL 33029. Service lines: Primary Care, Urgent Care, Cardiology, Orthopedics, Imaging. Full competitive picture within 3 miles. Full data.';
  assert.strictEqual(detectMode(q), 'marketing_plan');
  assert.strictEqual(detectPlanType(q), 'facility_opening');
  const intents = classifyIntent(q);
  assert.ok(intents.includes('competitive'));
  assert.ok(intents.includes('locations'));
  assert.ok(!intents.includes('psychographic'), 'Section 4 should NOT load psychographic');
  const lines = extractServiceLines(q);
  assert.ok(lines.includes('primary_care'));
  assert.ok(lines.includes('urgent_care'));
  assert.ok(lines.includes('cardiology'));
  assert.ok(lines.includes('orthopedics'));
  assert.ok(lines.includes('imaging'));
});

// ── Scenario 3: Section 4 competitive (service line plan, cardiology only) ──
test('S3: Section 4 cardiology service line → competitive, service line = cardiology', () => {
  const q = 'For Section 4 of the marketing plan. Service line expansion for cardiology in Broward County. Competitive landscape for cardiology near Pembroke Pines. Full data.';
  assert.strictEqual(detectMode(q), 'marketing_plan');
  assert.strictEqual(detectPlanType(q), 'service_line');
  const intents = classifyIntent(q);
  assert.ok(intents.includes('competitive'));
  const lines = extractServiceLines(q);
  assert.ok(lines.includes('cardiology'));
  assert.ok(!lines.includes('orthopedics'), 'Should NOT extract unmentioned service lines');
});

// ── Scenario 4: Section 5 with address but no ZIPs ──
test('S4: Section 5 with address but no ZIPs → trade_area intent triggered', () => {
  const q = 'For Section 5 of the marketing plan. Facility Opening: Urgent Care at 18503 Pines Blvd, Pembroke Pines FL 33029. Full demographic analysis. Full data.';
  const intents = classifyIntent(q);
  assert.ok(intents.includes('demographics'));
  assert.ok(intents.includes('trade_area'), 'Should trigger trade_area when Section 5 + address + no ZIPs');
});

// ── Scenario 5: Physician query (Pembroke Pines) ──
test('S5: Physician query → physicians intent, adjacency map loaded in prompt', () => {
  const q = 'Find all BH cardiologists within 15 minutes of Pembroke Pines';
  assert.strictEqual(detectMode(q), 'general_research');
  const intents = classifyIntent(q);
  assert.ok(intents.includes('physicians'));
  const prompt = buildSystemPrompt(q);
  assert.ok(prompt.includes('SOUTH FLORIDA CITY ADJACENCY MAP'), 'Physician prompt should include adjacency map');
});

// ── Scenario 6: Partnership launch (One Medical) ──
test('S6: Partnership launch → plan type = partnership_launch', () => {
  const q = 'For Section 10 of the marketing plan. Partnership Launch: Baptist Health replacing UHealth as the specialty referral network for One Medical in South Florida. Find all One Medical locations. Full data.';
  assert.strictEqual(detectMode(q), 'marketing_plan');
  assert.strictEqual(detectPlanType(q), 'partnership_launch');
});

// ── Scenario 7: General research review query ──
test('S7: General research review query → general_research, competitive, NO plan-type lens', () => {
  const q = 'Pull reviews for Memorial Pembroke Pines. What are patients saying?';
  assert.strictEqual(detectMode(q), 'general_research');
  assert.strictEqual(detectPlanType(q), null);
  const intents = classifyIntent(q);
  assert.ok(intents.includes('competitive'), 'Reviews use competitive workflow');
  assert.ok(!intents.includes('demographics'));
  assert.ok(!intents.includes('psychographic'));
  const prompt = buildSystemPrompt(q);
  assert.ok(!prompt.includes('PLAN CONTEXT FOR THIS QUERY'), 'General research should NOT have plan context');
});

// ── Scenario 8: Section 2 situation analysis ──
test('S8: Section 2 situation analysis → competitive + demographics', () => {
  const q = 'For Section 2 of the marketing plan. Facility Opening: Multi-Specialty Medical Center at 18503 Pines Blvd, Pembroke Pines FL. Market context for this trade area. Full data.';
  assert.strictEqual(detectMode(q), 'marketing_plan');
  const intents = classifyIntent(q);
  assert.ok(intents.includes('competitive'), 'Section 2 should include competitive');
  assert.ok(intents.includes('demographics'), 'Section 2 should include demographics');
});

console.log(`\n\u2500\u2500 Scenarios: ${passed} passed, ${failed} failed \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\n`);
if (failed > 0) process.exit(1);
