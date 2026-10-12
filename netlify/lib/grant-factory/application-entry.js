"use strict";
const C = require('./core');
const workflow = require('../../../assets/opportunity-workflow');
const STAGES = ['Ideas', 'Reviewing', 'Qualified', 'Planning', 'Writing', 'Submitted', 'Awarded', 'Not Awarded'];
const ACTIVE = STAGES.slice(0, 5);
function requestApplicationId(org, request) {
  const h = C.hash('grant-factory/standalone/' + C.id(org) + '/' + C.id(request)).slice(0, 32);
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-5' + h.slice(13, 16) + '-a' + h.slice(17, 20) + '-' + h.slice(20);
}
function availability(item, opportunity, application) {
  if (application) return {
    action: application.deleted_at ? 'deleted' : 'open', application_id: application.id,
    application_status: application.status,
    explanation: application.deleted_at ? 'This application is in Deleted applications. Restore it there to continue.' : 'Open the existing application. Saved work is preserved.',
  };
  if (!ACTIVE.includes(item.stage)) return { action: 'unavailable', explanation: 'This item is ' + item.stage + '. No new application can be started for a completed capture; keep its history or capture a new grant cycle.' };
  if (!opportunity) return { action: 'unavailable', explanation: 'The captured funding record is unavailable. Start a standalone grant with the official source, or correct the capture record.' };
  const deadline=opportunity.deadline instanceof Date?opportunity.deadline.toISOString():opportunity.deadline;
  if (opportunity.source_active === false || workflow.daysUntil(deadline, workflow.day(new Date(), 'America/New_York')) < 0)
    return { action: 'unavailable', explanation: 'This opportunity is closed or its deadline has passed. Verify and capture a current cycle before starting its application.' };
  return { action: 'import', explanation: ['Ideas', 'Reviewing'].includes(item.stage) ? 'Eligibility still needs review in Capture Pipeline. Starting a workspace does not qualify the grant or change its stage.' : 'Open a linked workspace and check the captured application source. Its Capture stage stays unchanged.' };
}
module.exports = { STAGES, ACTIVE, requestApplicationId, availability };
