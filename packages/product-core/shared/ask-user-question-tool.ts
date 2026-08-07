/** True for the AskUserQuestion tool across the casing variants different
 *  agents emit (`AskUserQuestion` / `ask_user_question` / `askUserQuestion`).
 *  Why: this is the structured "pick an option" prompt whose full input the
 *  clients render as a live card. Shared so the hook listener and the
 *  renderer's Escape gate discriminate it identically. */
export function isAskUserQuestionTool(toolName: string | undefined): boolean {
  return toolName?.replaceAll(/[^a-z0-9]/gi, '').toLowerCase() === 'askuserquestion'
}
