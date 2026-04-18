/**
 * carrierGateways.js
 *
 * US carrier email-to-SMS gateway map and phone number carrier lookup via Numverify.
 *
 * Usage:
 *   const { lookupCarrier, getGatewayEmail, CARRIER_OPTIONS } = require('./carrierGateways');
 *
 *   // Auto-detect carrier from phone number (calls Numverify once, then cached):
 *   const carrier = await lookupCarrier('+15551234567');
 *   // → 'verizon' | 'at&t' | 't-mobile' | null
 *
 *   // Build the SMS gateway email:
 *   const email = getGatewayEmail('5551234567', 'verizon');
 *   // → '5551234567@vtext.com'
 *
 * Numverify is called ONCE per phone number at store-time and the result is
 * cached in the caller's user_profile row (key: 'self:phone_carrier').
 * The free tier gives 100 req/month which is more than sufficient.
 */

'use strict';

const https = require('https');
const http = require('http');

// ── Carrier → SMS gateway domain map ────────────────────────────────────────
// Sources: carrier websites + CTIA carrier gateway documentation (2024)
const CARRIER_GATEWAYS = {
  // Tier-1 US carriers
  'verizon':         'vtext.com',
  'at&t':            'txt.att.net',
  'att':             'txt.att.net',
  't-mobile':        'tmomail.net',
  'tmobile':         'tmomail.net',
  'sprint':          'messaging.sprintpcs.com',
  'boost mobile':    'sms.myboostmobile.com',
  'boost':           'sms.myboostmobile.com',
  'us cellular':     'email.uscc.net',
  'uscellular':      'email.uscc.net',
  // MVNOs and regional carriers
  'cricket':         'sms.cricketwireless.net',
  'cricket wireless':'sms.cricketwireless.net',
  'metro pcs':       'mymetropcs.com',
  'metro by t-mobile':'mymetropcs.com',
  'metropcs':        'mymetropcs.com',
  'straight talk':   'vtext.com',   // uses Verizon network
  'tracfone':        'mmst5.tracfone.com',
  'republic wireless':'text.republicwireless.com',
  'republic':        'text.republicwireless.com',
  'consumer cellular':'mailmymobile.net',
  'consumer':        'mailmymobile.net',
  'google fi':       'msg.fi.google.com',
  'fi':              'msg.fi.google.com',
  'mint mobile':     'mailmymobile.net',
  'mint':            'mailmymobile.net',
  'visible':         'vtext.com',    // uses Verizon towers
  'xfinity mobile':  'vtext.com',    // uses Verizon network
  'xfinity':         'vtext.com',
  'optimum mobile':  'txt.att.net',
  'optimum':         'txt.att.net',
  'wing':            'vtext.com',
  'simple mobile':   'tmomail.net',
  'simple':          'tmomail.net',
  'net10':           'txt.att.net',
  'total wireless':  'vtext.com',
  'total':           'vtext.com',
};

// ── Human-readable dropdown options (for prompt when Numverify is unavailable) ──
const CARRIER_OPTIONS = [
  { label: 'Verizon',          value: 'verizon' },
  { label: 'AT&T',             value: 'at&t' },
  { label: 'T-Mobile',         value: 't-mobile' },
  { label: 'Sprint',           value: 'sprint' },
  { label: 'Boost Mobile',     value: 'boost mobile' },
  { label: 'Cricket Wireless', value: 'cricket wireless' },
  { label: 'Metro by T-Mobile',value: 'metro by t-mobile' },
  { label: 'US Cellular',      value: 'us cellular' },
  { label: 'Consumer Cellular',value: 'consumer cellular' },
  { label: 'Google Fi',        value: 'google fi' },
  { label: 'Mint Mobile',      value: 'mint mobile' },
  { label: 'Visible',          value: 'visible' },
  { label: 'Xfinity Mobile',   value: 'xfinity mobile' },
  { label: 'Straight Talk',    value: 'straight talk' },
  { label: 'Tracfone',         value: 'tracfone' },
  { label: 'Republic Wireless',value: 'republic wireless' },
  { label: 'Simple Mobile',    value: 'simple mobile' },
  { label: 'Other',            value: null },
];

// ── Normalize a carrier name returned by Numverify ──────────────────────────
// Numverify returns strings like "Verizon Wireless", "AT&T Mobility LLC", etc.
function _normalizeCarrierName(raw) {
  if (!raw) return null;
  const s = raw.toLowerCase();
  if (s.includes('verizon'))       return 'verizon';
  if (s.includes('at&t') || s.includes('att'))  return 'at&t';
  if (s.includes('t-mobile') || s.includes('tmobile')) return 't-mobile';
  if (s.includes('sprint'))        return 'sprint';
  if (s.includes('boost'))         return 'boost mobile';
  if (s.includes('cricket'))       return 'cricket wireless';
  if (s.includes('metro'))         return 'metro by t-mobile';
  if (s.includes('us cellular') || s.includes('uscellular')) return 'us cellular';
  if (s.includes('consumer cellular')) return 'consumer cellular';
  if (s.includes('google fi') || s.includes(' fi ') || s.includes('google voice')) return 'google fi';
  if (s.includes('mint'))          return 'mint mobile';
  if (s.includes('visible'))       return 'visible';
  if (s.includes('xfinity'))       return 'xfinity mobile';
  if (s.includes('straight talk')) return 'straight talk';
  if (s.includes('tracfone'))      return 'tracfone';
  if (s.includes('republic'))      return 'republic wireless';
  if (s.includes('simple mobile')) return 'simple mobile';
  return null; // unknown but valid response
}

// ── Strip non-digit characters from a phone number ──────────────────────────
function _digitsOnly(phone) {
  if (!phone) return '';
  return String(phone).replace(/\D/g, '');
}

// ── Numverify carrier lookup ─────────────────────────────────────────────────
/**
 * Call the Numverify API to look up the carrier for a phone number.
 * Returns the normalized carrier name string (e.g. 'verizon') or null on error.
 *
 * This is intentionally called ONCE per phone number at store-time,
 * not at send-time. The result is persisted in user_profile by storeMemory.
 *
 * @param {string} phone   - Phone number in any format (digits stripped internally)
 * @param {string} [apiKey] - Numverify key (falls back to NUMVERIFY_API_KEY env var)
 * @returns {Promise<string|null>}
 */
async function lookupCarrier(phone, apiKey) {
  const key = apiKey || process.env.NUMVERIFY_API_KEY;
  if (!key) {
    throw new Error('[carrierGateways] NUMVERIFY_API_KEY not set — cannot auto-detect carrier');
  }

  const digits = _digitsOnly(phone);
  if (digits.length < 10) {
    throw new Error(`[carrierGateways] Invalid phone number: "${phone}"`);
  }

  return new Promise((resolve, reject) => {
    const url = `http://apilayer.net/api/validate?access_key=${encodeURIComponent(key)}&number=${encodeURIComponent(digits)}&country_code=US&format=1`;
    const req = http.get(url, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (json.error) {
            // Numverify returns { success: false, error: { code, info } }
            return reject(new Error(`[carrierGateways] Numverify error ${json.error.code}: ${json.error.info}`));
          }
          if (!json.valid) {
            return resolve(null); // number didn't validate — can't look up carrier
          }
          const normalized = _normalizeCarrierName(json.carrier);
          resolve(normalized);
        } catch (parseErr) {
          reject(new Error(`[carrierGateways] Failed to parse Numverify response: ${parseErr.message}`));
        }
      });
    });
    req.on('error', reject);
    req.setTimeout(8000, () => {
      req.destroy();
      reject(new Error('[carrierGateways] Numverify request timed out'));
    });
  });
}

// ── Build gateway email ──────────────────────────────────────────────────────
/**
 * Construct the email-to-SMS gateway address for a given phone + carrier.
 *
 * @param {string} phone    - Phone number (digits only or formatted)
 * @param {string} carrier  - Normalized carrier name (e.g. 'verizon')
 * @returns {string|null}   - Gateway email or null if carrier not in map
 */
function getGatewayEmail(phone, carrier) {
  if (!phone || !carrier) return null;
  const digits = _digitsOnly(phone);
  if (digits.length < 10) return null;
  // Use last 10 digits (strip country code)
  const localDigits = digits.length > 10 ? digits.slice(-10) : digits;
  const domain = CARRIER_GATEWAYS[carrier.toLowerCase()];
  if (!domain) return null;
  return `${localDigits}@${domain}`;
}

/**
 * Given a carrier name (raw from Numverify or user-provided), return the gateway domain.
 * Returns null if unmapped.
 *
 * @param {string} carrier - Carrier name (raw or normalized)
 * @returns {string|null}
 */
function getGatewayDomain(carrier) {
  if (!carrier) return null;
  const key = carrier.toLowerCase();
  return CARRIER_GATEWAYS[key] || CARRIER_GATEWAYS[_normalizeCarrierName(carrier)] || null;
}

module.exports = {
  CARRIER_GATEWAYS,
  CARRIER_OPTIONS,
  lookupCarrier,
  getGatewayEmail,
  getGatewayDomain,
  _normalizeCarrierName,  // exported for testing
  _digitsOnly,             // exported for testing
};
