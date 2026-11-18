import { hash } from './import.js';
export class MockDraftAdapter {
  mode="mock";
  async generate({prompt,route}){const data=JSON.parse(prompt.split('PROSPECT_DATA=')[1]);return {subject:`Product sourcing for ${data.company}`,english:`Hello ${data.company} team,\nYour published offering mentions ${data.need}. We can discuss a suitable product selection for that application. Which specifications matter most for your next sourcing review?\nThis is a synthetic test draft, not a real offer.`,chinese:`${data.company}团队您好：\n贵司公开资料提到${data.need}。我们希望了解相应产品应用，可否提供下一轮采购评估重视的规格？\n这是模拟测试草稿，并非真实报价。`};}
}
export class MockMailbox {
  mode = 'mock';
  messages = new Map();
  drafts = new Map();
  trash = new Map();
  failAfterAccept = false;
  failBeforeAccept = false;

  async checkCompatibility({signal} = {}) {
    const compatible = !signal?.aborted;
    return {compatible, mode: this.mode, checks: [{id: 'in-memory-fixture', ok: compatible}]};
  }

  async preflight(packet) {
    const result = {accountId: packet.accountId, accountVerified: true, recipientVerified: true, fresh: true};
    const draft = this.drafts.get(packet.idempotencyKey);
    if (!draft) return result;
    if (!matchesDraft(draft, packet)) return {...result, fresh: false};
    return {...result, draftBinding: {...draft.binding}};
  }

  async send(packet) {
    if (packet.signal?.aborted) throw Error('Cancelled before send');
    if (this.failBeforeAccept) throw Error('Mock transport failure');
    const id = packet.idempotencyKey;
    if (!this.messages.has(id)) {
      const draft = this.drafts.get(id);
      if (packet.draftBinding && (!matchesDraft(draft, packet) || !sameDraft(draft.binding, packet.draftBinding))) {
        throw Error('Mock draft no longer matches the approved packet');
      }
      this.messages.set(id, {
        status: 'sent', mode: 'mock', approvedHash: packet.approvedHash,
        messageId: 'mock_' + hash(id).slice(0, 12), recipient: packet.recipient,
        subject: packet.subject, body: packet.body,
        ...(packet.draftBinding ? {authoritative: true, draftBinding: {...packet.draftBinding}} : {})
      });
    }
    if (this.failAfterAccept) throw Error('Mock lost acknowledgement');
    return structuredClone(this.messages.get(id));
  }

  async reconcile({idempotencyKey}) {
    return structuredClone(this.messages.get(idempotencyKey) ?? {status: 'not_sent', authoritative: true});
  }

  async trashSentDraft(packet) {
    if (packet.signal?.aborted) throw Error('Cancelled before draft cleanup');
    const receipt = this.messages.get(packet.idempotencyKey);
    if (receipt?.messageId !== packet.sentMessageId || receipt?.authoritative !== true
      || !sameDraft(receipt.draftBinding, packet.draftBinding)) throw Error('Unverified original mock draft');
    const proof = {
      authoritative: true, sentMessageId: packet.sentMessageId, draftBinding: {...packet.draftBinding}
    };
    const draft = this.drafts.get(packet.idempotencyKey);
    if (!draft) return {...proof, status: 'already_absent'};
    if (!matchesDraft(draft, packet) || !sameDraft(draft.binding, packet.draftBinding)) {
      throw Error('Mock draft changed after send');
    }
    this.trash.set(packet.idempotencyKey, draft);
    this.drafts.delete(packet.idempotencyKey);
    return {...proof, status: 'trashed'};
  }
}

const sameDraft = (a, b) => Boolean(a && b && ['accountId', 'draftId', 'draftVersion', 'approvedHash']
  .every(field => a[field] === b[field]));
const matchesDraft = (draft, packet) => draft?.binding.accountId === packet.accountId
  && draft.binding.approvedHash === packet.approvedHash && draft.recipient === packet.recipient
  && draft.subject === packet.subject && draft.body === packet.body;
