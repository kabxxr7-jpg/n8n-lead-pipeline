// HubSpot payloads and the two emails. Every user value is escaped before it goes into HTML.

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function oneLine(s, max) {
  return String(s ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function websiteUrl(w) {
  if (!w) return '';
  return /^https?:\/\//i.test(w) ? w : `https://${w}`;
}

function hubspotContactUpsert(lead) {
  const properties = {
    email: lead.email,
    firstname: lead.first_name,
    lastname: lead.last_name || '',
    company: lead.company,
    lifecyclestage: 'lead',
    hs_lead_status: 'NEW',
  };
  if (lead.website) properties.website = websiteUrl(lead.website);
  return { inputs: [{ idProperty: 'email', id: lead.email, properties }] };
}

const CRM_NAMES = { hubspot: 'HubSpot', zoho: 'Zoho CRM' };

function zohoLeadUpsert(lead, q) {
  const record = {
    Last_Name: lead.last_name || lead.first_name,
    First_Name: lead.last_name ? lead.first_name : '',
    Email: lead.email,
    Company: lead.company,
    Lead_Status: 'Not Contacted',
    Description: oneLine(`Score ${q.score}/100 (${q.tier}). ${q.reason}`, 1000),
  };
  if (lead.website) record.Website = websiteUrl(lead.website);
  return { data: [record], duplicate_check_fields: ['Email'], trigger: [] };
}

function plainNoteText(lead, q, leadId) {
  return [
    `Lead score ${q.score}/100 (${q.tier}), scored by ${q.scored_by === 'ai' ? 'Google Gemini' : 'the rules fallback'}.`,
    q.reason,
    `Suggested next step: ${NEXT_STEP_TEXT[q.next_step] || q.next_step}`,
    `Red flags: ${q.red_flags.length ? q.red_flags.join(', ') : 'none'}`,
    `Service: ${lead.service} | Budget: ${lead.budget} | Timeline: ${lead.timeline}`,
    '',
    'Message:',
    lead.message,
    '',
    `Source: n8n lead pipeline demo. Lead id ${leadId}.`,
  ].join('\n');
}

function zohoNote(lead, q, { leadId }) {
  return { data: [{ Note_Title: oneLine(`Lead score ${q.score}/100 (${q.tier})`, 120), Note_Content: plainNoteText(lead, q, leadId) }] };
}

const NEXT_STEP_TEXT = {
  book_call: 'Book a discovery call',
  send_proposal_questions: 'Send scoping questions',
  nurture: 'Add to nurture, check back later',
  decline_politely: 'Decline politely',
};

function hubspotNote(lead, q, { contactId, leadId, nowMs }) {
  const flags = q.red_flags.length ? q.red_flags.map((f) => `<li>${escapeHtml(f)}</li>`).join('') : '<li>none</li>';
  const body = [
    `<p><strong>Lead score ${q.score}/100 (${escapeHtml(q.tier)})</strong>, scored by ${q.scored_by === 'ai' ? 'Google Gemini' : 'the rules fallback'}.</p>`,
    `<p>${escapeHtml(q.reason)}</p>`,
    `<p><strong>Suggested next step:</strong> ${escapeHtml(NEXT_STEP_TEXT[q.next_step] || q.next_step)}</p>`,
    `<p><strong>Red flags:</strong></p><ul>${flags}</ul>`,
    `<p><strong>Service:</strong> ${escapeHtml(lead.service)}<br><strong>Budget:</strong> ${escapeHtml(lead.budget)}<br><strong>Timeline:</strong> ${escapeHtml(lead.timeline)}</p>`,
    `<p><strong>Message:</strong><br>${escapeHtml(lead.message).replace(/\n/g, '<br>')}</p>`,
    `<p>Source: n8n lead pipeline demo. Lead id ${escapeHtml(leadId)}.</p>`,
  ].join('');
  return {
    properties: { hs_timestamp: new Date(nowMs).toISOString(), hs_note_body: body },
    associations: [{ to: { id: String(contactId) }, types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: 202 }] }],
  };
}

const SERVICE_PHRASE = {
  'New website': 'new website',
  'Website redesign': 'website redesign',
  'SEO & content': 'SEO and content',
  'Automation & integrations': 'automation and integrations',
  'Not sure yet': 'website',
};

const REPLY_BY_TIER = {
  hot: 'Your project looks like a strong fit. Someone from the team will email you within one business day to set up a 30-minute discovery call.',
  warm: 'Thanks for the details. We will send you a few short scoping questions within two business days so we can come back with a clear estimate.',
  cold: 'Thanks for thinking of us. Based on what you shared we may not be the right fit right now, but we have saved your note and will be in touch if that changes.',
};

const DEMO_FOOTER_TEXT =
  'This is a live demo. Fernbrook Studio is a fictional business; this reply was sent by an n8n workflow built by Kabiir Labs (kabiirlabs.com) because this address was entered in the demo form at n8n.kabiirlabs.com. No further emails will be sent.';

function leadReplyEmail(lead, q, { from, statusUrl, leadId }) {
  const first = oneLine(lead.first_name, 40);
  const subject = oneLine(`Thanks ${first}, we got your project details`, 120);
  const lines = [
    `Hi ${first},`,
    '',
    `Thanks for telling us about the ${SERVICE_PHRASE[lead.service] || 'web'} project at ${oneLine(lead.company, 120)}.`,
    '',
    REPLY_BY_TIER[q.tier],
    '',
    `You can see exactly what happened to your enquiry here: ${statusUrl}`,
    '',
    'Fernbrook Studio (demo)',
    '',
    '--',
    DEMO_FOOTER_TEXT,
  ];
  const html = [
    '<div style="font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.55;color:#1f2933;max-width:560px">',
    `<p>Hi ${escapeHtml(first)},</p>`,
    `<p>Thanks for telling us about the ${escapeHtml(SERVICE_PHRASE[lead.service] || 'web')} project at ${escapeHtml(lead.company)}.</p>`,
    `<p>${escapeHtml(REPLY_BY_TIER[q.tier])}</p>`,
    `<p><a href="${escapeHtml(statusUrl)}" style="color:#2f6f4f">See what happened to your enquiry, step by step</a></p>`,
    '<p>Fernbrook Studio (demo)</p>',
    `<hr style="border:none;border-top:1px solid #e3e7eb;margin:24px 0"><p style="font-size:12px;color:#6b7785">${escapeHtml(DEMO_FOOTER_TEXT)}</p>`,
    '</div>',
  ].join('');
  return { from, to: [lead.email], subject, text: lines.join('\n'), html, headers: { 'X-Entity-Ref-ID': leadId } };
}

function teamAlertEmail(lead, q, { from, to, statusUrl, crm, problems }) {
  const urgent = problems.length > 0;
  const subject = oneLine(
    urgent
      ? `[ACTION NEEDED] Lead from ${lead.company}: ${problems.join('; ')}`
      : `[${q.tier.toUpperCase()} ${q.score}] New lead: ${lead.company}`,
    150,
  );
  const crmName = CRM_NAMES[crm.name] || 'CRM';
  const crmLine = crm.saved
    ? `${crmName} record: ${crm.contactUrl || '(saved; open the CRM to see it)'}`
    : `${crmName}: NOT SAVED. The details below are the only copy; add them by hand.`;
  const text = [
    urgent ? `Something failed for this lead: ${problems.join('; ')}. The lead still got the reply email unless listed above.` : 'New lead qualified by the pipeline.',
    '',
    `Score: ${q.score}/100 (${q.tier}), by ${q.scored_by === 'ai' ? 'Gemini' : 'rules fallback'}${q.fallback_reason ? ` (${q.fallback_reason})` : ''}`,
    `Why: ${q.reason}`,
    `Next step: ${NEXT_STEP_TEXT[q.next_step] || q.next_step}`,
    `Red flags: ${q.red_flags.length ? q.red_flags.join(', ') : 'none'}`,
    '',
    `Name: ${lead.name}`,
    `Email: ${lead.email}`,
    `Company: ${lead.company}`,
    `Website: ${lead.website || '-'}`,
    `Service: ${lead.service} | Budget: ${lead.budget} | Timeline: ${lead.timeline}`,
    '',
    'Message:',
    lead.message,
    '',
    crmLine,
    `Pipeline status: ${statusUrl}`,
  ].join('\n');
  return { from, to: [to], subject, text };
}
