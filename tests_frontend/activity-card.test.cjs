const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
class Element {
  constructor(tag) { this.tagName = tag; this.children = []; this.scrollTop = 0; this.scrollHeight = 0; this.listeners = {}; }
  attachShadow() { return this.shadowRoot = new Element('shadow'); }
  append(...elements) { this.children.push(...elements); }
  replaceChildren(...elements) { this.children = elements; }
  setAttribute() {}
  addEventListener(name, fn) { this.listeners[name] = fn; }
  querySelectorAll() { return this.children.flatMap(el => [...(el.tagName === 'details' && el.open ? [el] : []), ...el.querySelectorAll()]); }
}
function card(config = {}) {
  const definitions = new Map();
  const context = {HTMLElement: Element, document: {createElement: tag => new Element(tag)},
    window: {}, customElements: {get: name => definitions.get(name), define: (name, value) => definitions.set(name, value)},
    setTimeout, clearTimeout, console};
  vm.runInNewContext(fs.readFileSync('cards/meshcore-activity-card.js', 'utf8'), context);
  const instance = new (definitions.get('meshcore-activity-card'))();
  instance.setConfig(config);
  return instance;
}
const event = (type, payload = {}, entry = 'one') => ({event_type: 'meshcore_raw_event',
  data: {event_type: `EventType.${type}`, payload, timestamp: 1791051001, entry_id: entry}});
const settle = () => new Promise(resolve => setImmediate(resolve));

test('filters chat and local queue traffic but keeps adverts and repeater replies', () => {
  const c = card();
  for (const type of ['CHANNEL_MSG_RECV','CONTACT_MSG_RECV','NO_MORE_MSGS','BATTERY','CHANNEL_INFO','MSG_SENT']) c._receive(event(type));
  for (const type of [2,5,6]) c._receive(event('RX_LOG_DATA', {payload_type:type}));
  assert.equal(c._rows.length, 0);
  c._receive(event('RX_LOG_DATA', {payload_type:4, snr:5, rssi:-90}));
  c._receive(event('STATUS_RESPONSE', {pubkey_pre:'7ba6bb9f620e',uptime:42}));
  c._receive(event('TELEMETRY_RESPONSE'));
  assert.equal(c._rows.length, 3);
  assert.equal(c._rows[2].category, 'adverts');
  assert.equal(c._rows[1].key, '7ba6bb9f620e');
  c.disconnectedCallback();
});
test('entry filter, pause, bounded history and raw-payload bound', () => {
  const c = card({entry_id:'one',max_events:10});
  c._receive(event('ADVERTISEMENT', {}, 'two'));
  assert.equal(c._rows.length,0);
  c._paused = true; c._receive(event('ADVERTISEMENT')); assert.equal(c._rows.length,0);
  c._paused = false;
  for (let i=0; i<20; i++) c._receive(event('ADVERTISEMENT',{adv_name:`Node ${i}`,huge:'x'.repeat(30000)}));
  assert.equal(c._rows.length,10);
  assert.equal(c._rows[0].name,'Node 19');
  assert.ok(c._rows[0].raw.length <= 12000);
  assert.equal(c._rows[0].payload.huge,undefined);
  c.disconnectedCallback();
});
test('uses text content for untrusted advertised names and renders raw details', () => {
  const c = card();
  c._receive(event('NEW_CONTACT',{adv_name:'<img src=x onerror=alert(1)>',public_key:'aa'.repeat(32)}));
  c._renderRows();
  const details = c._feed.children[0];
  assert.equal(details.children[0].children[1].children[1].textContent,
    'Contact discovered · <img src=x onerror=alert(1)>');
  assert.ok(details.children[1].textContent.includes('public_key'));
  c.disconnectedCallback();
});
test('unsubscribes pending subscriptions when removed before setup resolves', async () => {
  const c = card(); c.isConnected = true;
  const pending = [], unsubscribed = [];
  c.hass = {connection: {subscribeEvents: () => new Promise(resolve => pending.push(resolve))}};
  c.isConnected = false; c.disconnectedCallback();
  pending.forEach((resolve, index) => resolve(() => unsubscribed.push(index)));
  await settle();
  assert.equal(unsubscribed.length,3);
  assert.equal(c._unsubs.length,0);
});
test('does not duplicate subscriptions and releases old connection on replacement', async () => {
  const c = card(); c.isConnected = true;
  let subscriptions=0, unsubscribed=0;
  const connection = {subscribeEvents: async () => {subscriptions++; return () => unsubscribed++;}};
  c.hass = {connection}; await settle();
  c.hass = {connection}; await settle(); assert.equal(subscriptions,3);
  c.hass = {connection: {...connection}}; await settle();
  assert.equal(unsubscribed,3); assert.equal(subscriptions,6);
  c.isConnected=false; c.disconnectedCallback(); assert.equal(unsubscribed,6);
});
test('reports permission errors instead of claiming the feed is listening', async () => {
  const c = card(); c.isConnected=true;
  c.hass = {connection: {subscribeEvents: async () => {throw new Error('unauthorized');}}};
  await settle(); assert.match(c._status,/subscription failed/);
  c.isConnected=false; c.disconnectedCallback();
});
