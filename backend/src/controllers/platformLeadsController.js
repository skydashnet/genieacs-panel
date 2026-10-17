import Lead, { LEAD_STATUSES } from '../models/Lead.js';
import PlatformAudit from '../models/PlatformAudit.js';
import { createResponse, createErrorResponse } from '../utils/helpers.js';

function presentLead(lead) {
  return {
    id: lead.id,
    name: lead.name,
    company: lead.company ?? null,
    email: lead.email ?? null,
    phone: lead.phone ?? null,
    city: lead.city ?? null,
    devicesEstimate: lead.devices_estimate === null || lead.devices_estimate === undefined
      ? null
      : Number(lead.devices_estimate),
    message: lead.message ?? null,
    planCode: lead.plan_code ?? null,
    status: lead.status,
    notes: lead.notes ?? null,
    source: lead.source,
    createdAt: lead.created_at ?? null,
    updatedAt: lead.updated_at ?? null
  };
}

/** Os pedidos de demonstração, como o console os trabalha. */
class PlatformLeadsController {
  static async list(req, res) {
    try {
      const status = req.query?.status ? String(req.query.status) : null;
      if (status && !LEAD_STATUSES.includes(status)) {
        return res.status(400).json(createErrorResponse('Invalid status'));
      }
      const [leads, counts] = await Promise.all([Lead.list({ status }), Lead.countByStatus()]);
      return res.json(createResponse('Leads retrieved', { leads: leads.map(presentLead), counts }));
    } catch (error) {
      console.error('List leads error:', error);
      return res.status(500).json(createErrorResponse('Failed to list leads', error.message));
    }
  }

  static async update(req, res) {
    try {
      const id = Number(req.params?.id);
      if (!Number.isInteger(id) || id < 1) return res.status(400).json(createErrorResponse('Invalid lead id'));
      const lead = await Lead.findById(id);
      if (!lead) return res.status(404).json(createErrorResponse('Lead not found'));
      const body = req.body ?? {};
      const patch = {};
      if (body.status !== undefined) {
        if (!LEAD_STATUSES.includes(body.status)) return res.status(400).json(createErrorResponse('Invalid status'));
        patch.status = body.status;
      }
      if (body.notes !== undefined) {
        const notes = body.notes === null ? '' : String(body.notes).trim();
        if (notes.length > 4000) return res.status(400).json(createErrorResponse('Notes must be at most 4000 characters'));
        patch.notes = notes || null;
      }
      if (!Object.keys(patch).length) return res.status(400).json(createErrorResponse('Nothing to update'));
      const updated = await Lead.update(id, patch);
      await PlatformAudit.fromRequest(req, {
        action: PlatformAudit.ACTIONS.LEAD_UPDATED,
        detail: { id, before: { status: lead.status }, after: { status: updated.status } }
      });
      return res.json(createResponse('Lead updated', { lead: presentLead(updated) }));
    } catch (error) {
      console.error('Update lead error:', error);
      return res.status(500).json(createErrorResponse('Failed to update the lead', error.message));
    }
  }
}

export default PlatformLeadsController;
