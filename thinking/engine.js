import { getContext } from '../../../../extensions.js';
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
import { SlashCommandParser } from '../../../../slash-commands/SlashCommandParser.js';

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
    if (!generationCaptured()) {
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
    if (!generationCaptured()) {
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

/**
 * @param {ThinkingPrompt[]} prompts
 * @return {Promise<Map<string, string>>}
 */
async function generateCharacterThoughts(prompts) {
    const context = getContext();

    const promptInstructions = prompts
        .map(prompt => `${JSON.stringify(prompt.name)}:\n${prompt.prompt}`)
        .join('\n\n');
    const combinedPrompt = [
        'Generate one response for each of the following thinking categories.',
        'Return ONLY a valid JSON object. Do not use markdown fences or any text outside the JSON object.',
        'The object must contain exactly these category names as keys, with one plain-text string value per key.',
        'Example format: {"Thoughts":"...","Plans":"..."}',
        '',
        promptInstructions,
    ].join('\n');

    let result;
    let parsedThoughts;
    let isLengthAboveMinimum = true;
    do {
        result = await generateQuietThought(context, combinedPrompt);
        parsedThoughts = parseBatchedThoughts(result, prompts);
        isLengthAboveMinimum = [...parsedThoughts.values()]
            .every(thought => thought.length >= settings.min_thought_length);
        if (!isLengthAboveMinimum) {
            if (settings.is_thinking_popups_enabled) {
                toastr.warning(
                    `At least one generated thought is below the threshold of ${settings.min_thought_length} characters. Repeating generation...`,
                    'Stepped Thinking',
                    { timeOut: 3000 }
                );
            }
            await generationDelay();
        }
    } while (!isLengthAboveMinimum);

    return new Map([...parsedThoughts].map(([name, thought]) => [name, sanitizeThought(thought, context)]));
}

/**
 * @param {string} result
 * @param {ThinkingPrompt[]} prompts
 * @return {Map<string, string>}
 */
function parseBatchedThoughts(result, prompts) {
    if (typeof result !== 'string') {
        throw new Error('The thinking response was not text.');
    }

    let parsed;
    try {
        parsed = JSON.parse(normalizeJsonResponse(result));
    } catch {
        throw new Error('The thinking response was not valid JSON. Generation stopped so the category results are not misassigned.');
    }

    if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
        throw new Error('The thinking response must be a JSON object keyed by category name.');
    }

    const expectedNames = prompts.map(prompt => prompt.name);
    const actualNames = Object.keys(parsed);
    if (actualNames.length !== expectedNames.length || expectedNames.some(name => !Object.prototype.hasOwnProperty.call(parsed, name))) {
        throw new Error(`The thinking response must contain exactly these category keys: ${expectedNames.join(', ')}.`);
    }

    for (const name of expectedNames) {
        if (typeof parsed[name] !== 'string' || parsed[name].trim() === '') {
            throw new Error(`The thinking response for "${name}" must be a non-empty string.`);
        }
    }

    return new Map(expectedNames.map(name => [name, parsed[name]]));
}

/**
 * Models commonly wrap an otherwise valid JSON response in a markdown fence or a short
 * introductory sentence. Remove only those transport wrappers; the parsed value is still
 * required to be an object with exactly the configured category keys.
 *
 * @param {string} result
 * @return {string}
 */
function normalizeJsonResponse(result) {
    const trimmedResult = result.trim();
    const fencedMatch = trimmedResult.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
    if (fencedMatch) {
        return fencedMatch[1].trim();
    }

    const objectStart = trimmedResult.indexOf('{');
    const objectEnd = trimmedResult.lastIndexOf('}');
    if (objectStart > 0 && objectEnd > objectStart) {
        return trimmedResult.slice(objectStart, objectEnd + 1);
    }

    return trimmedResult;
}

/**
 * @param {string} thought
 * @param {object} context
 * @return {string}
 */
function sanitizeThought(thought, context) {
    if (settings.regexp_to_sanitize.trim() !== '') {
        const regexp = context.substituteParams(settings.regexp_to_sanitize);
        return thought.replace(new RegExp(regexp, 'g'), '');
    }

    return thought;
}

async function generateQuietThought(context, prompt) {
    return withThinkingConnection(async () => {
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
    });
}

async function withThinkingConnection(callback) {
    const profileName = settings.thinking_connection_profile;
    if (!profileName) {
        return callback();
    }

    const profileCommand = SlashCommandParser.commands.profile;
    if (!profileCommand?.callback) {
        throw new Error('[Stepped Thinking] Cannot use the selected thinking connection profile because SillyTavern connection profiles are unavailable.');
    }

    const previousProfile = await profileCommand.callback({}, undefined);
    if (previousProfile === profileName) {
        return callback();
    }

    try {
        const appliedProfile = await profileCommand.callback({ await: 'true' }, profileName);
        if (appliedProfile !== profileName) {
            throw new Error(`[Stepped Thinking] The selected thinking connection profile "${profileName}" could not be applied.`);
        }

        return await callback();
    } finally {
        try {
            await profileCommand.callback({ await: 'true' }, previousProfile);
        } catch (error) {
            console.error('[Stepped Thinking] Failed to restore the main connection after thought generation', error);
            toastr.error('Failed to restore the main connection after thought generation', 'Stepped Thinking');
            throw error;
        }
    }
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
