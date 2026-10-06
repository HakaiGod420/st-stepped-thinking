import { extension_settings, getContext } from '../../../../extensions.js';
import {
    event_types,
    eventSource,
    extractMessageBias,
    Generate,
    sendMessageAsUser,
    substituteParams,
} from '../../../../../script.js';
import { generationCaptured, releaseGeneration } from '../interconnection.js';
import { settings } from '../settings/settings.js';
import { is_group_generating } from '../../../../group-chats.js';
import { findMode, registerThinkingModeListeners } from './mode.js';
import { registerPromptAdjustmentListeners } from './prompt_adjustment.js';
import { findChar, getCharIndex } from '../../../../utils.js';

/**
 * @type {{is_enabled: ?boolean, thinking_prompt_ids: ?number[]}}
 */
let chatThinkingSettings = {
    is_enabled: null,
    thinking_prompt_ids: null,
};

/**
 * @type {ThoughtsMode}
 */
let currentMode;
/**
 * @type {ThoughtsGenerationPlan}
 */
let currentGenerationPlan;

/**
 * @type {boolean}
 */
let isThinking = false;
let toastThinking, sendTextareaOriginalPlaceholder;

// event listeners

/**
 * @return {void}
 */
export function registerGenerationEventListeners() {
    if (settings.is_shutdown) {
        return;
    }

    eventSource.on(event_types.GENERATION_STOPPED, stopChatThinking);
    // DEBUG
    // eventSource.on(event_types.GENERATE_AFTER_COMBINE_PROMPTS, (event) => console.log('STDEBUG TC Final Prompt', event.prompt));
    // eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, (event) => console.log('STDEBUG CC Final Prompt', event.chat));
    //
    eventSource.on(event_types.GENERATION_STARTED, removeOrphanThoughts);
    eventSource.on(event_types.GENERATION_AFTER_COMMANDS, runChatThinking);
    eventSource.makeLast(event_types.GENERATION_AFTER_COMMANDS, prepareGenerationPrompt);

    eventSource.on(event_types.MESSAGE_RECEIVED, saveCharacterThoughts);
    eventSource.on(event_types.MESSAGE_DELETED, renderAndHideThoughts);
    eventSource.on(event_types.CHAT_CHANGED, renderInitialThoughts);
    $(document).on('mouseup touchend', '#show_more_messages', renderThoughts);
    $(document).on('click', '.mes_hide', onHideClick);
    $(document).on('click', '.mes_unhide', onHideClick);

    registerThinkingModeListeners();
    registerPromptAdjustmentListeners();
}

/**
 * @return {Promise<void>}
 */
export async function hideThoughts() {
    const characterId = parseInt(getContext().characterId);
    if (Number.isNaN(characterId)) {
        return;
    }

    await currentGenerationPlan.hideThoughts(characterId);
}

/**
 * @return {Promise<void>}
 */
async function onHideClick() {
    const messageBlock = $(this).closest('.mes');
    const messageId = Number(messageBlock.attr('mesid'));

    const context = getContext();
    const characterName = context.chat[messageId].name;
    await currentGenerationPlan.hideThoughts(findChatCharacterIdByName(characterName));
}

/**
 * @return {Promise<void>}
 */
async function renderAndHideThoughts() {
    await renderThoughts();
    await hideThoughts();
}

/**
 * @return {Promise<void>}
 */
async function renderInitialThoughts() {
    await currentMode.renderInitialCharacterThoughts();
}

/**
 * @return {Promise<void>}
 */
async function renderThoughts() {
    await currentMode.renderCharacterThoughts();
}

/**
 * @return {Promise<void>}
 */
async function removeOrphanThoughts() {
    if (!isThinking) {
        await bindIntermediateThoughts();
    }
    currentMode.removeOrphanThoughts();
}

/**
 * @return {Promise<void>}
 */
async function saveCharacterThoughts() {
    await currentGenerationPlan.saveCharacterThoughts();
    currentGenerationPlan = currentMode.createDefaultGenerationPlan();
}

/**
 * @return {void}
 */
async function bindIntermediateThoughts() {
    currentGenerationPlan.orphanIntermediateUnboundThoughts();
    await currentGenerationPlan.saveCharacterThoughts();
    await currentGenerationPlan.hideThoughts();

    currentGenerationPlan = currentMode.createDefaultGenerationPlan();
}

/**
 * @param {string} type
 * @return {Promise<void>}
 */
async function prepareGenerationPrompt(type) {
    if (getContext().groupId && !is_group_generating) {
        return;
    }
    if (!isCharacterSelected()) {
        return;
    }

    await currentGenerationPlan.prepareGenerationPrompt(type);
}

/**
 * @param {string} generatedThought
 * @param {ThinkingPrompt} thinkingPrompt
 * @return {Promise<void>}
 */
async function putCharactersThoughts(generatedThought, thinkingPrompt) {
    const thinkingPromptSubstituted = Object.assign({}, thinkingPrompt);
    thinkingPromptSubstituted.name = substituteParams(thinkingPrompt.name);
    thinkingPromptSubstituted.prompt = substituteParams(thinkingPrompt.prompt);

    await currentGenerationPlan.putCharacterThoughts(generatedThought, thinkingPromptSubstituted);
}

/**
 * @returns {Promise<void>}
 */
async function stopChatThinking() {
    await stopThinking($('#send_textarea'));
}

/**
 * @param {string} type
 * @param {object} options
 * @param {boolean} isDryRun
 * @return {Promise<void>}
 */
async function runChatThinking(type, options, isDryRun) {
    if (isDryRun) {
        return;
    }

    if (!isExtensionEnabled() || !isGenerationTypeAllowed(type) || !isCharacterSelected() || isThinking) {
        return;
    }
    if (isThinkingSkipped(chatThinkingSettings.thinking_prompt_ids)) {
        await hideThoughts();
        return;
    }

    await runNewThoughtsGeneration($('#send_textarea'), chatThinkingSettings.thinking_prompt_ids);
    await generationDelay();
}

// core functions

/**
 * @param {JQuery<HTMLTextAreaElement>} textarea
 * @return {void}
 */
export async function stopThinking(textarea) {
    isThinking = false;
    if (toastThinking) {
        toastr.clear(toastThinking);
    }

    textarea.prop('readonly', false);

    if (sendTextareaOriginalPlaceholder) {
        textarea.attr('placeholder', sendTextareaOriginalPlaceholder);
    }

    await bindIntermediateThoughts();

    releaseGeneration();
}

/**
 * @param {JQuery<HTMLTextAreaElement>} textarea
 * @param {?number[]} targetPromptIds
 * @return {Promise<void>}
 */
export async function runNewThoughtsGeneration(textarea, targetPromptIds = null) {
    if (!await generationCaptured()) {
        return;
    }
    isThinking = true;

    try {
        await sendUserMessage(textarea);

        const templatePosition = await currentMode.sendCharacterTemplateMessage();
        currentGenerationPlan = currentMode.createNewThoughtsGenerationPlan(
            templatePosition,
            getCurrentCharacterPrompts(targetPromptIds),
            getContext().characterId
        );

        await currentGenerationPlan.hideThoughts();
        await generateThoughtsWithDisabledInput(textarea);
        await currentGenerationPlan.hideThoughts();
    } finally {
        isThinking = false;
        releaseGeneration();
    }
}

/**
 * @param {ThoughtPosition} targetThought
 * @return {Promise<void>}
 */
export async function runRefreshGeneratedThoughts(targetThought) {
    if (!await generationCaptured()) {
        return;
    }
    isThinking = true;

    try {
        currentGenerationPlan = currentMode.createRefreshThoughtsGenerationPlan(targetThought);

        await currentGenerationPlan.hideThoughts();
        await generateThoughts();

        await currentGenerationPlan.saveCharacterThoughts();
    } finally {
        await currentGenerationPlan.hideThoughts();

        isThinking = false;
        currentGenerationPlan = currentMode.createDefaultGenerationPlan();
        releaseGeneration();
    }
}

/**
 * @param {JQuery<HTMLTextAreaElement>} textarea
 * @param {number[]} targetPromptIds
 * @return {Promise<void>}
 */
export async function runNewBoundThoughtsGeneration(textarea, targetPromptIds) {
    const context = getContext();

    if (!currentMode.isEmbeddedInMessages()) {
        await runNewThoughtsGeneration(textarea, targetPromptIds);
        return;
    }

    const characterId = typeof context.characterId === 'string'
        ? Number(context.characterId)
        : context.characterId;

    chatThinkingSettings = {
        is_enabled: true,
        thinking_prompt_ids: targetPromptIds,
    };
    Generate('normal', { force_chid: characterId })
        .finally(() => chatThinkingSettings = {
            is_enabled: null,
            thinking_prompt_ids: null,
        });
}

/**
 * @param {string} characterName
 * @return {Promise<number>}
 */
export async function deleteHiddenThoughts(characterName) {
    return await currentMode.deleteHiddenThoughts(characterName.length > 0 ? characterName : null);
}

/**
 * @param {string} name
 * @return {void}
 */
export function switchMode(name) {
    currentMode = findMode(name);
    currentGenerationPlan = currentMode.createDefaultGenerationPlan();
}

/**
 * @param {string} characterName
 * @return {number}
 */
export function findChatCharacterIdByName(characterName) {
    return getCharIndex(findChatCharacterByName(characterName));
}

/**
 * @param {string} characterName
 * @return {v1CharData}
 */
export function findChatCharacterByName(characterName) {
    return findChar({ name: characterName, allowAvatar: false });
}

/**
 * @param {string} characterName
 * @return {v1CharData}
 */
export function findChatCharacterByNameQuiet(characterName) {
    return findChar({ name: characterName, allowAvatar: false, quiet: true });
}

/**
 * @param {?number} characterId
 * @return {?CharacterThinkingSettings}
 */
export function getCharacterSettings(characterId = null) {
    const context = getContext();
    const targetCharacterId = characterId !== null ? characterId : context.characterId;

    if (Number.isNaN(parseInt(targetCharacterId))) {
        return null;
    }

    const characterAvatar = context.characters[targetCharacterId].avatar;
    return settings.character_settings?.find(setting => setting.avatar === characterAvatar && setting.is_setting_enabled);
}

/**
 * @return {Promise<void>}
 */
export async function generationDelay() {
    if (settings.generation_delay > 0.0) {
        console.log('[Stepped Thinking] Delaying generation for', settings.generation_delay, 'seconds');
        await new Promise(resolve => setTimeout(resolve, settings.generation_delay * 1000));
        console.log('[Stepped Thinking] Generation delay complete');
    }
}

/**
 * @param {JQuery<HTMLTextAreaElement>} textarea
 * @return {Promise<void>}
 */
async function sendUserMessage(textarea) {
    const text = String(textarea.val());
    if (text.trim() === '') {
        return;
    }

    const bias = extractMessageBias(text);

    textarea.val('')[0].dispatchEvent(new Event('input', { bubbles: true }));
    await sendMessageAsUser(text, bias);
}

/**
 * The Generate function sends input from #send_textarea before starting generation. Since the user probably doesn't
 * want their input to be suddenly sent when the character finishes thinking, the input field is disabled during the process
 *
 * @param {JQuery<HTMLTextAreaElement>} textarea
 * @return {Promise<void>}
 */
async function generateThoughtsWithDisabledInput(textarea) {
    sendTextareaOriginalPlaceholder = textarea.attr('placeholder');
    textarea.attr('placeholder', 'When a character is thinking, the input area is disabled');
    textarea.prop('readonly', true);
    textarea.val('')[0].dispatchEvent(new Event('input', { bubbles: true }));

    await generateThoughts().finally(() => {
        textarea.prop('readonly', false);
        textarea.attr('placeholder', sendTextareaOriginalPlaceholder);
        sendTextareaOriginalPlaceholder = null;
    });
}

/**
 * @return {Promise<void>}
 */
async function generateThoughts() {
    const context = getContext();

    if (settings.is_thinking_popups_enabled) {
        const toastThinkingMessage = context.substituteParams('{{char}} is thinking...');
        toastThinking = toastr.info(toastThinkingMessage, 'Stepped Thinking', { timeOut: 0, extendedTimeOut: 0 });
    }

    try {
        const prompts = currentGenerationPlan.getThinkingPrompts().filter(prompt => prompt.prompt);
        validateBatchedPrompts(prompts);
        const generatedThoughts = await generateCharacterThoughts(prompts);

        for (const prompt of prompts) {
            await putCharactersThoughts(generatedThoughts.get(prompt.name), prompt);
        }
    } catch (error) {
        toastr.clear(toastThinking);
        toastThinking = null;
        console.error('[Stepped Thinking] Failed to generate batched thoughts', error);
        toastr.error(error.message, 'Stepped Thinking');
        throw error;
    }

    toastr.clear(toastThinking);
    toastThinking = null;
    if (settings.is_thinking_popups_enabled) {
        toastr.success('Done!', 'Stepped Thinking', { timeOut: 2000 });
    }
}

/**
 * @param {ThinkingPrompt[]} prompts
 * @return {void}
 */
function validateBatchedPrompts(prompts) {
    const names = prompts.map(prompt => prompt.name.trim());
    if (names.some(name => name.length === 0)) {
        throw new Error('Every enabled thinking prompt must have a category name before generation can start.');
    }

    if (new Set(names).size !== names.length) {
        throw new Error('Enabled thinking prompts must have unique category names before generation can start.');
    }
}

const MAX_GENERATION_ATTEMPTS = 4;

class ThoughtParseError extends Error {}

/**
 * @param {ThinkingPrompt[]} prompts
 * @return {Promise<Map<string, string>>}
 */
async function generateCharacterThoughts(prompts) {
    const context = getContext();
    const combinedPrompt = buildCombinedPrompt(prompts);

    let lastError = null;
    for (let attempt = 1; attempt <= MAX_GENERATION_ATTEMPTS; attempt++) {
        try {
            const result = await generateQuietThought(context, combinedPrompt);
            const parsedThoughts = parseBatchedThoughts(result, prompts);

            const isLengthAboveMinimum = [...parsedThoughts.values()]
                .every(thought => thought.length >= settings.min_thought_length);
            if (isLengthAboveMinimum) {
                return new Map([...parsedThoughts].map(([name, thought]) => [name, sanitizeThought(thought, context)]));
            }

            lastError = new ThoughtParseError(`A generated thought stayed below the minimum length of ${settings.min_thought_length} characters.`);
            notifyRetry(`At least one generated thought is below the threshold of ${settings.min_thought_length} characters. Repeating generation...`);
        } catch (error) {
            if (!(error instanceof ThoughtParseError)) {
                throw error;
            }

            lastError = error;
            console.warn(`[Stepped Thinking] Attempt ${attempt}/${MAX_GENERATION_ATTEMPTS} failed: ${error.message}`);
            notifyRetry('The response could not be parsed. Retrying...');
        }

        if (attempt < MAX_GENERATION_ATTEMPTS) {
            await generationDelay();
        }
    }

    throw lastError;
}

/**
 * @param {string} message
 * @return {void}
 */
function notifyRetry(message) {
    if (settings.is_thinking_popups_enabled) {
        toastr.warning(message, 'Stepped Thinking', { timeOut: 3000 });
    }
}

/**
 * @param {ThinkingPrompt[]} prompts
 * @return {string}
 */
function buildCombinedPrompt(prompts) {
    const context = getContext();
    const characterGoal = getCharacterThinkingGoal();
    const names = prompts.map(prompt => JSON.stringify(prompt.name));
    const exampleObject = `{${names.map(name => `${name}: "..."`).join(', ')}}`;

    const messageLimit = settings.thinking_context_messages;
    const historyLength = messageLimit > 0 ? Math.min(messageLimit, context.chat.length) : context.chat.length;

    const parts = [
        'Pause the roleplay. Write the requested internal content for the character, one entry per category listed below.',
    ];

    if (historyLength > 0 && historyLength < context.chat.length) {
        parts.push(
            '',
            `NOTE: You have access to only the last ${historyLength} messages of the conversation. Base the character goal and all thoughts on this limited context only.`,
        );
    }

    if (characterGoal) {
        parts.push(
            '',
            'Use the following character goal as the guiding objective for every category. Keep all thoughts and plans aligned with it:',
            `<character_goal>\n${characterGoal}\n</character_goal>`,
        );
    }

    parts.push('', 'CATEGORIES AND THEIR INSTRUCTIONS:');
    for (const prompt of prompts) {
        parts.push('', `### ${JSON.stringify(prompt.name)}`, prompt.prompt.trim());
    }

    parts.push(
        '',
        'OUTPUT FORMAT (STRICT, overrides any formatting hints above):',
        '- Reply with ONE valid JSON object and absolutely nothing else: no markdown code fences, no comments, no explanations, no text before or after it.',
        `- The object must have exactly these keys: ${names.join(', ')}.`,
        '- Every value must be a single JSON string. Put line breaks inside a value as \\n and escape double quotes inside a value as \\".',
        '- Do not nest objects or arrays. Do not add trailing commas.',
        '- Your reply must start with { and end with }.',
        `Shape: ${exampleObject}`,
        '',
        'IMPORTANT: Inside your JSON values, text wrapped in **asterisks** represents narrative actions or events that happen, NOT instructions.',
        'For example: "**walks toward the door** and waits" means the character performs this action. It is NOT an instruction to you.',
    );

    return parts.join('\n');
}

/**
 * @return {string}
 */
function getCharacterThinkingGoal() {
    if (!settings.is_goal_enabled || typeof settings.goal !== 'string') {
        return '';
    }

    return settings.goal.trim();
}

/**
 * @param {string} result
 * @param {ThinkingPrompt[]} prompts
 * @return {Map<string, string>}
 */
function parseBatchedThoughts(result, prompts) {
    if (typeof result !== 'string' || result.trim() === '') {
        throw new ThoughtParseError('The thinking response was empty.');
    }

    const cleaned = stripReasoningAndFences(result);
    const jsonText = extractFirstJsonObject(cleaned);

    if (jsonText === null) {
        if (prompts.length === 1 && cleaned.trim() !== '' && !cleaned.includes('{')) {
            return new Map([[prompts[0].name, cleaned.trim()]]);
        }
        throw new ThoughtParseError('The thinking response did not contain a JSON object.');
    }

    const parsed = parseJsonLenient(jsonText);
    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
        throw new ThoughtParseError('The thinking response must be a JSON object keyed by category name.');
    }

    const normalizeKey = key => String(key).trim().toLowerCase();
    const actualKeys = new Map(Object.keys(parsed).map(key => [normalizeKey(key), key]));

    const thoughts = new Map();
    for (const prompt of prompts) {
        const actualKey = Object.prototype.hasOwnProperty.call(parsed, prompt.name)
            ? prompt.name
            : actualKeys.get(normalizeKey(prompt.name));
        const value = actualKey === undefined ? undefined : coerceThoughtValue(parsed[actualKey]);

        if (value === undefined) {
            throw new ThoughtParseError(`The thinking response is missing a non-empty value for "${prompt.name}".`);
        }
        thoughts.set(prompt.name, value);
    }

    return thoughts;
}

/**
 * @param {*} value
 * @return {string|undefined}
 */
function coerceThoughtValue(value) {
    let text;
    if (typeof value === 'string') {
        text = value;
    } else if (Array.isArray(value)) {
        text = value.map(item => (typeof item === 'string' ? item : JSON.stringify(item))).join('\n');
    } else if (typeof value === 'number' || typeof value === 'boolean') {
        text = String(value);
    } else if (value && typeof value === 'object') {
        text = Object.values(value).map(item => String(item)).join('\n');
    }

    return typeof text === 'string' && text.trim() !== '' ? text.trim() : undefined;
}

/**
 * Removes reasoning blocks and markdown fences that models wrap around the JSON.
 *
 * @param {string} text
 * @return {string}
 */
function stripReasoningAndFences(text) {
    let result = text
        .replace(/<(think|thinking|reasoning|thought)>[\s\S]*?<\/\1>/gi, '')
        .replace(/^[\s\S]*?<\/(think|thinking|reasoning)>/i, '')
        .trim();

    const fenced = result.match(/```(?:json|JSON)?\s*([\s\S]*?)```/);
    if (fenced && fenced[1].includes('{')) {
        result = fenced[1].trim();
    } else {
        result = result.replace(/^```(?:json|JSON)?/, '').trim();
    }

    return result;
}

/**
 * Finds the first balanced {...} block, respecting string literals.
 *
 * @param {string} text
 * @return {?string}
 */
function extractFirstJsonObject(text) {
    const start = text.indexOf('{');
    if (start === -1) {
        return null;
    }

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
        const char = text[i];
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (char === '\\') {
                escaped = true;
            } else if (char === '"') {
                inString = false;
            }
            continue;
        }

        if (char === '"') {
            inString = true;
        } else if (char === '{') {
            depth++;
        } else if (char === '}') {
            depth--;
            if (depth === 0) {
                return text.slice(start, i + 1);
            }
        }
    }

    return null;
}

/**
 * @param {string} jsonText
 * @return {*}
 */
function parseJsonLenient(jsonText) {
    try {
        return JSON.parse(jsonText);
    } catch {
        // fall through to the repair attempt
    }

    try {
        return JSON.parse(repairJson(jsonText));
    } catch {
        throw new ThoughtParseError('The thinking response was not valid JSON.');
    }
}

/**
 * Escapes raw control characters inside strings and drops trailing commas.
 *
 * @param {string} text
 * @return {string}
 */
function repairJson(text) {
    let output = '';
    let inString = false;
    let escaped = false;

    for (let i = 0; i < text.length; i++) {
        const char = text[i];

        if (inString) {
            if (escaped) {
                escaped = false;
                output += char;
            } else if (char === '\\') {
                escaped = true;
                output += char;
            } else if (char === '"') {
                inString = false;
                output += char;
            } else if (char === '\n') {
                output += '\\n';
            } else if (char === '\r') {
                output += '\\r';
            } else if (char === '\t') {
                output += '\\t';
            } else {
                output += char;
            }
            continue;
        }

        if (char === '"') {
            inString = true;
            output += char;
        } else if (char === ',' && /^\s*[}\]]/.test(text.slice(i + 1))) {
            continue;
        } else {
            output += char;
        }
    }

    return output;
}

/**
 * @param {string} thought
 * @param {object} context
 * @return {string}
 */
function sanitizeThought(thought, context) {
    if (settings.regexp_to_sanitize.trim() === '') {
        return thought;
    }

    try {
        const regexp = context.substituteParams(settings.regexp_to_sanitize);
        return thought.replace(new RegExp(regexp, 'g'), '').trim();
    } catch (error) {
        console.warn('[Stepped Thinking] Invalid sanitizing regexp, skipping it', error);
        return thought;
    }
}

/**
 * @return {?object}
 */
function findThinkingProfile() {
    const selected = settings.thinking_connection_profile;
    if (!selected) {
        return null;
    }

    const profiles = extension_settings.connectionManager?.profiles ?? [];
    const profile = profiles.find(item => item.id === selected) ?? profiles.find(item => item.name === selected);
    if (!profile) {
        throw new Error(`The selected thinking connection profile "${selected}" no longer exists. Choose another one in the Stepped Thinking settings.`);
    }

    return profile;
}

/**
 * @param {object} context
 * @param {string} prompt
 * @return {Promise<string>}
 */
async function generateQuietThought(context, prompt) {
    const profile = findThinkingProfile();
    if (profile) {
        return await requestThoughtViaProfile(context, profile, prompt);
    }

    // The main connection is used as is, nothing is switched.
    const originalChat = context.chat.slice();
    const messageLimit = settings.thinking_context_messages;
    if (messageLimit > 0 && originalChat.length > messageLimit) {
        context.chat.splice(0, originalChat.length - messageLimit);
    }

    try {
        return await context.generateQuietPrompt({
            quietPrompt: prompt,
            skipWIAN: settings.is_wian_skipped,
            responseLength: settings.max_response_length,
            forceChId: currentGenerationPlan.getCharacterId(),
        });
    } finally {
        context.chat.splice(0, context.chat.length, ...originalChat);
    }
}

/**
 * Sends the request straight to the chosen connection profile without touching the user's active connection.
 *
 * @param {object} context
 * @param {object} profile
 * @param {string} prompt
 * @return {Promise<string>}
 */
async function requestThoughtViaProfile(context, profile, prompt) {
    const service = context.ConnectionManagerRequestService;
    if (!service?.sendRequest) {
        throw new Error('SillyTavern connection profiles are unavailable. Enable the Connection Profiles extension or update SillyTavern.');
    }

    const maxTokens = settings.max_response_length > 0 ? settings.max_response_length : 2048;
    const messages = buildProfileMessages(context, prompt);

    const response = await service.sendRequest(profile.id, messages, maxTokens, {
        stream: false,
        extractData: true,
        includePreset: true,
        includeInstruct: true,
    });

    return typeof response === 'string' ? response : response?.content;
}

/**
 * @param {object} context
 * @param {string} prompt
 * @return {{role: string, content: string}[]}
 */
function buildProfileMessages(context, prompt) {
    const characterId = Number(currentGenerationPlan.getCharacterId());
    const character = context.characters?.[characterId];
    const userName = context.name1 || 'User';
    const characterName = character?.name || context.name2 || 'Character';

    const sections = [];
    if (character) {
        const card = [
            ['Description', character.description],
            ['Personality', character.personality],
            ['Scenario', character.scenario],
        ]
            .filter(([, value]) => typeof value === 'string' && value.trim() !== '')
            .map(([title, value]) => `${title}: ${value.trim()}`);
        sections.push(`You are ${characterName}.\n${card.join('\n')}`);
    }

    const persona = context.powerUserSettings?.persona_description;
    if (typeof persona === 'string' && persona.trim() !== '') {
        sections.push(`${userName} (the user) is: ${persona.trim()}`);
    }

    const messageLimit = settings.thinking_context_messages;
    let history = context.chat.filter(message => !message.is_system && typeof message.mes === 'string' && message.mes.trim() !== '');
    if (messageLimit > 0) {
        history = history.slice(-messageLimit);
    }
    if (history.length > 0) {
        sections.push('Recent chat:\n' + history.map(message => `${message.name}: ${message.mes.trim()}`).join('\n\n'));
    }

    sections.push(prompt);

    return [
        { role: 'system', content: substituteParams(`You are a roleplay engine that writes a character's hidden inner state as strict JSON. You never add commentary outside the JSON.`) },
        { role: 'user', content: substituteParams(sections.join('\n\n'), userName, characterName) },
    ];
}

/**
 * @param {?number} characterId
 * @return {boolean}
 */
function isExtensionEnabled(characterId = null) {
    if (chatThinkingSettings.is_enabled !== null) {
        return chatThinkingSettings.is_enabled;
    }

    if (characterId !== null) {
        const characterSettings = getCharacterSettings(characterId);
        if (characterSettings && characterSettings.is_setting_enabled) {
            return characterSettings.is_thinking_enabled;
        }
    }

    return settings.is_enabled;
}

/**
 * @param {?string} type
 * @return {boolean}
 */
function isGenerationTypeAllowed(type) {
    if (getContext().groupId) {
        if (!is_group_generating) {
            return false;
        }
        if (type !== 'normal' && type !== 'group_chat') {
            return false;
        }
    } else {
        if (type !== 'normal') {
            return false;
        }
    }

    return true;
}

/**
 * @return {boolean}
 */
function isCharacterSelected() {
    const context = getContext();
    if (Number.isNaN(parseInt(context.characterId))) {
        console.log('[Stepped Thinking] No character selected for thoughts generation', context.characterId);
        return false;
    }

    return true;
}

/**
 * @param {number[]} targetPromptIds
 * @return {boolean}
 */
function isThinkingSkipped(targetPromptIds = null) {
    return !isExtensionEnabled(getContext().characterId)
        || getCurrentCharacterPrompts(targetPromptIds).length === 0;
}

/**
 * @param {number[]} targetPromptIds
 * @return {ThinkingPrompt[]}
 */
function getCurrentCharacterPrompts(targetPromptIds = null) {
    const characterSettings = getCharacterSettings();
    /** @var {function(ThinkingPrompt): boolean} */
    const filterEnabledOrTargetPrompts = prompt => {
        if (targetPromptIds !== null) {
            return targetPromptIds.includes(prompt.id);
        }
        return prompt.is_enabled !== false;
    };

    if (characterSettings) {
        const characterPrompts = characterSettings.thinking_prompts.filter(filterEnabledOrTargetPrompts);
        if (characterPrompts && characterPrompts.length > 0) {
            return characterPrompts;
        }
    }

    return settings.thinking_prompts.filter(filterEnabledOrTargetPrompts);
}
