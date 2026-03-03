/**
 * Batch-update the "Display Text" column in the Abilities tab of the Tirs game spreadsheet.
 *
 * Uses existing OAuth credentials from ~/.sheets-cli/
 * Usage: node scripts/update-display-text.js
 */

const { google } = require('googleapis');
const fs = require('fs');
const path = require('path');

const SPREADSHEET_ID = '17lSSg1vt-m9sM9kfVxL0Noxy-mGClb8RfzedWf5aDlk';
const SHEET_NAME = 'Abilities';
const DISPLAY_TEXT_COL = 'J'; // "Display Text" is column J

// Auth files location
const AUTH_DIR = path.join(process.env.USERPROFILE || process.env.HOME, '.sheets-cli');
const CREDENTIALS_PATH = path.join(AUTH_DIR, 'credentials.json');
const TOKEN_PATH = path.join(AUTH_DIR, 'token.json');

// ── Display Text values to set ──────────────────────────────────
// Template placeholders: {unit}, {target}, {killer}, {deadAlly}, {attacker}

const DISPLAY_TEXT = {
  // Parting Gifts (death triggers — invisible without toast)
  'Parting Gift - Lance':     '{unit} passes Shove to {target}',
  'Parting Gift - Bracer':    '{unit} passes protection to {target}',
  'Parting Gift - Cuirass':   '{unit} passes armor to {target}',
  'Parting Gift - Greaves':   '{unit} passes mobility to {target}',
  'Parting Gift - Cloak':     '{unit} passes stealth to {target}',
  'Parting Gift - Jump Pack': '{unit} passes evasion to {target}',
  'Parting Gift - Scope':     '{unit} passes true sight to {target}',
  'Parting Gift - Shield':    '{unit} passes shielding to {target}',
  'Parting Gift - Sniper':    '{unit} passes sneak attack to {target}',
  'Parting Gift - Stimpak':   '{unit} passes regeneration to {target}',
  'Parting Gift - Visor':     '{unit} passes targeting to {target}',
  'Parting Gift - Slider':    '{unit} passes tumbling to {target}',

  // Remember abilities (allyDeath — invisible without toast)
  'Remember - Affliction':  '{unit} remembers {deadAlly} — affliction spreads',
  'Remember - Conquest':    '{unit} remembers {deadAlly} — conquest empowers',
  'Remember - Hunger':      '{unit} remembers {deadAlly} — hunger grows',
  'Remember - Slaughter':   '{unit} remembers {deadAlly} — slaughter fuels rage',
  'Remember - Guidance':    '{unit} is guided by {deadAlly}\'s memory',

  // Dusters legendaries (pre-damage hooks — subtle)
  'Plagued Memories':       '{unit} spreads plague to nearby allies',
  'Sanguine Echoes':        '{unit} redirects excess damage to nearest ally',
  'Dutiful Reflection':     '{unit} intercepts the attack on an ally',
  'Deprived Recollection':  '{unit} drains a bonus activation from {target}',
  'Sweeping':               '{unit} unleashes absorbed gifts on death',
  'Shiney':                 '{unit} collects another gift — growing stronger',

  // Death/whenAttacked triggers (confirmation feedback)
  'Volatile':       '{unit} explodes on death!',
  'Noroi':          '{unit} curses {attacker}',
  'Dodgy':          '{unit} dodges the attack!',
  'Touch Me Not':   '{unit} dodges the attack!',
  'Hover':          '{unit} evades to safety',
  'Barbed':         '{unit} retaliates with barbs',
  'Sharp Thorn':    '{unit} retaliates with thorns',
  'Chilling Mist':  '{unit} reduces damage with chilling mist',
  'Nothing':        '{unit} fades into nothing',

  // Activation/action triggers (confirmation)
  'Diffuser':   '{unit} diffuses nearby terrain',
  'Hot Suit':   '{unit} redirects burning',
  'Wound Up':   '{unit} winds up the traps',

  // Hymns (dramatic moment)
  'Hymn of Life':        'Hymn of Life — all allies healed!',
  'Hymn of Protection':  'Hymn of Protection — all allies shielded!',
  'Hymn of Power':       'Hymn of Power — all allies strengthened!',
  'Hymn of Currents':    'Hymn of Currents — enemies pushed!',
  'Hymn of Enticement':  'Hymn of Enticement — enemies pulled!',
  'Hymn of Shivers':     'Hymn of Shivers — all enemies vulnerable!',
  'Hymn of Guidance':    'Hymn of Guidance — all allies empowered!',
  'Hymn of Dread':       'Hymn of Dread — all enemies weakened!',
  'Hymn of Potential':   'Hymn of Potential — transformation begins!',
};

async function main() {
  // Load auth
  if (!fs.existsSync(CREDENTIALS_PATH)) {
    console.error(`Credentials not found at ${CREDENTIALS_PATH}`);
    process.exit(1);
  }
  if (!fs.existsSync(TOKEN_PATH)) {
    console.error(`Token not found at ${TOKEN_PATH}. Run sheets-cli auth first.`);
    process.exit(1);
  }

  const credentials = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
  const token = JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8'));

  const { client_id, client_secret, redirect_uris } = credentials.installed || credentials.web;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
  oAuth2Client.setCredentials(token);

  // Auto-save refreshed token
  oAuth2Client.on('tokens', (newTokens) => {
    const updated = { ...token, ...newTokens };
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(updated, null, 2));
    console.log('Token refreshed and saved.');
  });

  const sheets = google.sheets({ version: 'v4', auth: oAuth2Client });

  // Step 1: Read current Abilities tab to find row numbers
  console.log('Reading Abilities tab...');
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:J`,
  });

  const rows = res.data.values || [];
  if (rows.length === 0) {
    console.error('No data found in Abilities tab.');
    process.exit(1);
  }

  // Find header row (row with "Abilities" in column A)
  let headerIdx = 0;
  for (let i = 0; i < rows.length; i++) {
    if (rows[i][0] && rows[i][0].toLowerCase().includes('abilit')) {
      headerIdx = i;
      break;
    }
  }
  console.log(`Header at row ${headerIdx + 1}`);

  // Build ability name → sheet row number map
  const abilityRows = {};
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const name = (rows[i][0] || '').trim();
    if (name) abilityRows[name] = i + 1; // 1-indexed sheet row
  }

  // Step 2: Build batch update data
  const updateData = [];
  const missing = [];

  for (const [abilityName, displayText] of Object.entries(DISPLAY_TEXT)) {
    const row = abilityRows[abilityName];
    if (!row) {
      missing.push(abilityName);
      continue;
    }
    updateData.push({
      range: `${SHEET_NAME}!${DISPLAY_TEXT_COL}${row}`,
      values: [[displayText]],
    });
  }

  if (missing.length > 0) {
    console.warn(`\nAbilities not found in sheet (${missing.length}):`);
    missing.forEach(n => console.warn(`  - ${n}`));
  }

  if (updateData.length === 0) {
    console.log('No updates to apply.');
    return;
  }

  // Step 3: Apply batch update
  console.log(`\nUpdating ${updateData.length} abilities...`);
  const result = await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: SPREADSHEET_ID,
    requestBody: {
      valueInputOption: 'USER_ENTERED',
      data: updateData,
    },
  });

  console.log(`Done! Updated ${result.data.totalUpdatedCells} cells.`);

  // Summary
  console.log('\nUpdated abilities:');
  for (const [name, text] of Object.entries(DISPLAY_TEXT)) {
    if (abilityRows[name]) {
      console.log(`  ✓ ${name}: "${text}"`);
    }
  }
}

main().catch(err => {
  console.error('Error:', err.message);
  process.exit(1);
});
