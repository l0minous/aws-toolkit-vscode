/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import {
    CancellationToken,
    InlineCompletionContext,
    InlineCompletionItem,
    InlineCompletionItemProvider,
    Position,
    TextDocument,
    commands,
    languages,
    Disposable,
    window,
    TextEditor,
    InlineCompletionTriggerKind,
    Range,
} from 'vscode'
import { LanguageClient } from 'vscode-languageclient'
import {
    InlineCompletionItemWithReferences,
    LogInlineCompletionSessionResultsParams,
} from '@aws/language-server-runtimes/protocol'
import { SessionManager } from './sessionManager'
import { RecommendationService } from './recommendationService'
import {
    CodeWhispererConstants,
    ReferenceHoverProvider,
    ReferenceLogViewProvider,
    ImportAdderProvider,
    CodeSuggestionsState,
    vsCodeState,
    inlineCompletionsDebounceDelay,
    noInlineSuggestionsMsg,
    ReferenceInlineProvider,
} from 'aws-core-vscode/codewhisperer'
import { InlineGeneratingMessage } from './inlineGeneratingMessage'
import { LineTracker } from './stateTracker/lineTracker'
import { InlineTutorialAnnotation } from './tutorials/inlineTutorialAnnotation'
import { TelemetryHelper } from './telemetryHelper'
import { getLogger } from 'aws-core-vscode/shared'
import { debounce, messageUtils } from 'aws-core-vscode/utils'

export class InlineCompletionManager implements Disposable {
    private disposable: Disposable
    private inlineCompletionProvider: AmazonQInlineCompletionItemProvider
    private languageClient: LanguageClient
    private sessionManager: SessionManager
    private recommendationService: RecommendationService
    private lineTracker: LineTracker
    private incomingGeneratingMessage: InlineGeneratingMessage
    private inlineTutorialAnnotation: InlineTutorialAnnotation
    private readonly logSessionResultMessageName = 'aws/logInlineCompletionSessionResults'

    constructor(
        languageClient: LanguageClient,
        sessionManager: SessionManager,
        lineTracker: LineTracker,
        inlineTutorialAnnotation: InlineTutorialAnnotation
    ) {
        this.languageClient = languageClient
        this.sessionManager = sessionManager
        this.lineTracker = lineTracker
        this.incomingGeneratingMessage = new InlineGeneratingMessage(this.lineTracker)
        this.recommendationService = new RecommendationService(this.sessionManager, this.incomingGeneratingMessage)
        this.inlineTutorialAnnotation = inlineTutorialAnnotation
        this.inlineCompletionProvider = new AmazonQInlineCompletionItemProvider(
            languageClient,
            this.recommendationService,
            this.sessionManager,
            this.inlineTutorialAnnotation
        )
        this.disposable = languages.registerInlineCompletionItemProvider(
            CodeWhispererConstants.platformLanguageIds,
            this.inlineCompletionProvider
        )

        this.lineTracker.ready()
    }

    public dispose(): void {
        if (this.disposable) {
            this.disposable.dispose()
            this.incomingGeneratingMessage.dispose()
            this.lineTracker.dispose()
        }
    }

    public registerInlineCompletion() {
        const onInlineAcceptance = async (
            sessionId: string,
            item: InlineCompletionItemWithReferences,
            editor: TextEditor,
            requestStartTime: number,
            startLine: number,
            firstCompletionDisplayLatency?: number
        ) => {
            // TODO: also log the seen state for other suggestions in session
            const params: LogInlineCompletionSessionResultsParams = {
                sessionId: sessionId,
                completionSessionResult: {
                    [item.itemId]: {
                        seen: true,
                        accepted: true,
                        discarded: false,
                    },
                },
                totalSessionDisplayTime: Date.now() - requestStartTime,
                firstCompletionDisplayLatency: firstCompletionDisplayLatency,
            }
            this.languageClient.sendNotification(this.logSessionResultMessageName, params)
            this.disposable.dispose()
            this.disposable = languages.registerInlineCompletionItemProvider(
                CodeWhispererConstants.platformLanguageIds,
                this.inlineCompletionProvider
            )
            if (item.references && item.references.length) {
                const referenceLog = ReferenceLogViewProvider.getReferenceLog(
                    item.insertText as string,
                    item.references,
                    editor
                )
                ReferenceLogViewProvider.instance.addReferenceLog(referenceLog)
                ReferenceHoverProvider.instance.addCodeReferences(item.insertText as string, item.references)

                // Show codelense for 5 seconds.
                ReferenceInlineProvider.instance.setInlineReference(
                    startLine,
                    item.insertText as string,
                    item.references
                )
                setTimeout(() => {
                    ReferenceInlineProvider.instance.removeInlineReference()
                }, 5000)
            }
            if (item.mostRelevantMissingImports?.length) {
                await ImportAdderProvider.instance.onAcceptRecommendation(editor, item, startLine)
            }
            this.sessionManager.incrementSuggestionCount()
            // clear session manager states once accepted
            this.sessionManager.clear()
        }
        commands.registerCommand('aws.amazonq.acceptInline', onInlineAcceptance)

        const onInlineRejection = async () => {
            await commands.executeCommand('editor.action.inlineSuggest.hide')
            // TODO: also log the seen state for other suggestions in session
            this.disposable.dispose()
            this.disposable = languages.registerInlineCompletionItemProvider(
                CodeWhispererConstants.platformLanguageIds,
                this.inlineCompletionProvider
            )
            const sessionId = this.sessionManager.getActiveSession()?.sessionId
            const itemId = this.sessionManager.getActiveRecommendation()[0]?.itemId
            if (!sessionId || !itemId) {
                return
            }
            const params: LogInlineCompletionSessionResultsParams = {
                sessionId: sessionId,
                completionSessionResult: {
                    [itemId]: {
                        seen: true,
                        accepted: false,
                        discarded: false,
                    },
                },
            }
            this.languageClient.sendNotification(this.logSessionResultMessageName, params)
            // clear session manager states once rejected
            this.sessionManager.clear()
        }
        commands.registerCommand('aws.amazonq.rejectCodeSuggestion', onInlineRejection)
    }
}

export class AmazonQInlineCompletionItemProvider implements InlineCompletionItemProvider {
    constructor(
        private readonly languageClient: LanguageClient,
        private readonly recommendationService: RecommendationService,
        private readonly sessionManager: SessionManager,
        private readonly inlineTutorialAnnotation: InlineTutorialAnnotation
    ) {}

    private readonly logSessionResultMessageName = 'aws/logInlineCompletionSessionResults'
    provideInlineCompletionItems = debounce(
        this._provideInlineCompletionItems.bind(this),
        inlineCompletionsDebounceDelay,
        true
    )

    private async _provideInlineCompletionItems(
        document: TextDocument,
        position: Position,
        context: InlineCompletionContext,
        token: CancellationToken
    ): Promise<InlineCompletionItem[]> {
        // prevent concurrent API calls and write to shared state variables
        if (vsCodeState.isRecommendationsActive) {
            return []
        }
        try {
            vsCodeState.isRecommendationsActive = true
            const isAutoTrigger = context.triggerKind === InlineCompletionTriggerKind.Automatic
            if (isAutoTrigger && !CodeSuggestionsState.instance.isSuggestionsEnabled()) {
                // return early when suggestions are disabled with auto trigger
                return []
            }

            // handling previous session
            const prevSession = this.sessionManager.getActiveSession()
            const prevSessionId = prevSession?.sessionId
            const prevItemId = this.sessionManager.getActiveRecommendation()?.[0]?.itemId
            const prevStartPosition = prevSession?.startPosition
            const editor = window.activeTextEditor
            if (prevSession && prevSessionId && prevItemId && prevStartPosition) {
                const prefix = document.getText(new Range(prevStartPosition, position))
                const prevItemMatchingPrefix = []
                for (const item of this.sessionManager.getActiveRecommendation()) {
                    const text = typeof item.insertText === 'string' ? item.insertText : item.insertText.value
                    if (text.startsWith(prefix) && position.isAfterOrEqual(prevStartPosition)) {
                        item.command = {
                            command: 'aws.amazonq.acceptInline',
                            title: 'On acceptance',
                            arguments: [
                                prevSessionId,
                                item,
                                editor,
                                prevSession?.requestStartTime,
                                position.line,
                                prevSession?.firstCompletionDisplayLatency,
                            ],
                        }
                        item.range = new Range(prevStartPosition, position)
                        prevItemMatchingPrefix.push(item as InlineCompletionItem)
                    }
                }
                // re-use previous suggestions as long as new typed prefix matches
                if (prevItemMatchingPrefix.length > 0) {
                    getLogger().debug(`Re-using suggestions that match user typed characters`)
                    return prevItemMatchingPrefix
                }
                getLogger().debug(`Auto rejecting suggestions from previous session`)
                // if no such suggestions, report the previous suggestion as Reject
                const params: LogInlineCompletionSessionResultsParams = {
                    sessionId: prevSessionId,
                    completionSessionResult: {
                        [prevItemId]: {
                            seen: true,
                            accepted: false,
                            discarded: false,
                        },
                    },
                }
                this.languageClient.sendNotification(this.logSessionResultMessageName, params)
                this.sessionManager.clear()
            }

            // tell the tutorial that completions has been triggered
            await this.inlineTutorialAnnotation.triggered(context.triggerKind)
            TelemetryHelper.instance.setInvokeSuggestionStartTime()
            TelemetryHelper.instance.setTriggerType(context.triggerKind)

            await this.recommendationService.getAllRecommendations(
                this.languageClient,
                document,
                position,
                context,
                token
            )
            // get active item from session for displaying
            const items = this.sessionManager.getActiveRecommendation()
            const itemId = this.sessionManager.getActiveRecommendation()?.[0]?.itemId
            const session = this.sessionManager.getActiveSession()

            // Show message to user when manual invoke fails to produce results.
            if (items.length === 0 && context.triggerKind === InlineCompletionTriggerKind.Invoke) {
                void messageUtils.showTimedMessage(noInlineSuggestionsMsg, 2000)
            }

            if (!session || !items.length || !editor) {
                getLogger().debug(
                    `Failed to produce inline suggestion results. Received ${items.length} items from service`
                )
                return []
            }

            const cursorPosition = document.validatePosition(position)

            if (position.isAfter(editor.selection.active)) {
                getLogger().debug(`Cursor moved behind trigger position. Discarding suggestion...`)
                const params: LogInlineCompletionSessionResultsParams = {
                    sessionId: session.sessionId,
                    completionSessionResult: {
                        [itemId]: {
                            seen: false,
                            accepted: false,
                            discarded: true,
                        },
                    },
                }
                this.languageClient.sendNotification(this.logSessionResultMessageName, params)
                this.sessionManager.clear()
                return []
            }

            // the user typed characters from invoking suggestion cursor position to receiving suggestion position
            const typeahead = document.getText(new Range(position, editor.selection.active))

            const itemsMatchingTypeahead = []

            for (const item of items) {
                item.insertText = typeof item.insertText === 'string' ? item.insertText : item.insertText.value
                if (item.insertText.startsWith(typeahead)) {
                    item.command = {
                        command: 'aws.amazonq.acceptInline',
                        title: 'On acceptance',
                        arguments: [
                            session.sessionId,
                            item,
                            editor,
                            session.requestStartTime,
                            cursorPosition.line,
                            session.firstCompletionDisplayLatency,
                        ],
                    }
                    item.range = new Range(cursorPosition, cursorPosition)
                    itemsMatchingTypeahead.push(item)
                    ImportAdderProvider.instance.onShowRecommendation(document, cursorPosition.line, item)
                }
            }

            // report discard if none of suggestions match typeahead
            if (itemsMatchingTypeahead.length === 0) {
                getLogger().debug(
                    `Suggestion does not match user typeahead from insertion position. Discarding suggestion...`
                )
                const params: LogInlineCompletionSessionResultsParams = {
                    sessionId: session.sessionId,
                    completionSessionResult: {
                        [itemId]: {
                            seen: false,
                            accepted: false,
                            discarded: true,
                        },
                    },
                }
                this.languageClient.sendNotification(this.logSessionResultMessageName, params)
                this.sessionManager.clear()
                return []
            }

            // suggestions returned here will be displayed on screen
            return itemsMatchingTypeahead as InlineCompletionItem[]
        } catch (e) {
            getLogger('amazonqLsp').error('Failed to provide completion items: %O', e)
            return []
        } finally {
            vsCodeState.isRecommendationsActive = false
        }
    }
}
