// Step grouping / splitting logic.
// Shared: used by app.js (recorder) and editor.js (split modal).
// Dual-mode export: works via require() or as a plain <script> tag.

const GROUP_WINDOW_MS = 6000; // sliding window between consecutive actions

// CRITICAL: this is a SLIDING window — comparison is always against lastActionAt
// (most recent action in the group), never against when the group started.
// A steady sequence stays merged indefinitely as long as no single gap exceeds 6s.
// A fixed window from group start was explicitly rejected — it would wrongly split
// a natural continuous sequence once total elapsed time crossed the threshold.
function shouldMergeWithGroup(lastGroup, meta, now) {
  if (!lastGroup) return false;
  if (lastGroup.pageUrl !== meta.pageUrl) return false; // navigation always breaks the group
  return (now - lastGroup.lastActionAt) <= GROUP_WINDOW_MS;
}

// Walk backward to find the last screenshot that actually captured successfully.
// Deliberately NOT the final action's own screenshot — the last action in a group
// is often exactly the navigating click (e.g. a submit button) most likely to lose
// the screenshot-capture race, so falling back still shows a useful "form filled in" image.
function screenshotForActions(actions) {
  for (let i = actions.length - 1; i >= 0; i--) {
    if (actions[i].screenshotDataUrl) return actions[i].screenshotDataUrl;
  }
  return null;
}

// Always number sub-steps so single-action steps ("1. Click") and
// multi-action steps ("1. Click\n2. Type") look consistent in the editor.
function textForActions(actions) {
  return actions.map((s, i) => `${i + 1}. ${s.text}`).join('\n');
}

// Thin wrappers for callers (stepsPanel.js) that work with the in-memory group shape
function groupText(group) { return textForActions(group.subActions); }
function groupScreenshot(group) { return screenshotForActions(group.subActions); }

// Convert an action array to the saved-step format.
// Always includes subSteps (even for single actions) so the editor textarea
// always shows a numbered list, regardless of how many sub-steps there are.
// The "Split up steps" button check (subSteps.length > 1) still works correctly.
function toSavedStep(actions) {
  return {
    text:              textForActions(actions),
    screenshotDataUrl: screenshotForActions(actions),
    subSteps:          actions.map(({ text, screenshotDataUrl }) => ({ text, screenshotDataUrl }))
  };
}

// Convert a full in-memory recording session into the steps array format guides are saved with
function toSavedSteps(groups) {
  return groups.map(group => toSavedStep(group.subActions));
}

if (typeof module !== 'undefined') {
  module.exports = {
    GROUP_WINDOW_MS, shouldMergeWithGroup,
    screenshotForActions, textForActions,
    groupText, groupScreenshot,
    toSavedStep, toSavedSteps
  };
} else {
  window.stepGroups = {
    GROUP_WINDOW_MS, shouldMergeWithGroup,
    screenshotForActions, textForActions,
    groupText, groupScreenshot,
    toSavedStep, toSavedSteps
  };
}
