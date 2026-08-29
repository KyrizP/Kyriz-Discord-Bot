'use strict';

// Shared fake Discord primitives for behavioral probes. Discord semantics:
// update/deferUpdate keep the SAME message (id preserved) — this fidelity is
// what lets tests drive panels across edits. Poker sends its panel via
// channel.send; other games via context.reply — both are recorded in ch.sent.

function fakeMsg(id) {
  return {
    id: id || 'panel-' + Math.random().toString(36).slice(2),
    edited: [],
    async edit(opts) { this.edited.push(opts); return this; },
  };
}

function fakeReply() {
  return {
    replied: null, deferred: false, shownModal: false, notes: [],
    async reply(opts) { this.replied = opts; return fakeMsg(); },
    async deferReply() { this.deferred = true; return fakeMsg(); },
    async deferUpdate() { this.deferred = true; return null; },
    async update(opts) { this.updated = true; this.replied = opts; return fakeMsg(); },
    async followUp(opts) { this.notes.push(opts); return fakeMsg(); },
    async showModal() { this.shownModal = true; },
  };
}

function fakeInteraction(user, customId, msg, fields) {
  const base = fakeReply();
  return Object.assign(base, {
    user: { id: user }, customId: customId || '', message: msg,
    isButton: () => true,
    fields: fields || { getTextInputValue: () => '0' },
    async update(opts) { this.updated = true; this.replied = opts; if (msg) msg.edited.push(opts); return msg; },
    async deferUpdate() { this.deferred = true; return msg; },
  });
}

function fakeModal(user, amount) {
  const base = fakeReply();
  return Object.assign(base, {
    user: { id: user },
    isModalSubmit: () => true,
    fields: { getTextInputValue: () => amount },
  });
}

function fakePrefixMessage(userId, content) {
  const state = { replyMsg: null };
  const ch = {
    sent: [],
    async send(opts) { const m = fakeMsg('send-' + this.sent.length); this.sent.push({ m, opts }); return m; },
  };
  return {
    author: { id: userId, bot: false }, guild: { id: 'g1' }, content, channel: ch,
    async reply(opts) {
      if (!state.replyMsg) state.replyMsg = fakeMsg('panel-' + userId);
      ch.sent.push({ m: state.replyMsg, opts });
      return state.replyMsg;
    },
  };
}

module.exports = { fakeMsg, fakeReply, fakeInteraction, fakeModal, fakePrefixMessage };
