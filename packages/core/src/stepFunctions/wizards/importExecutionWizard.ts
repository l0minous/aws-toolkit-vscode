/*!
 * Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as nls from 'vscode-nls'
const localize = nls.loadMessageBundle()

import * as vscode from 'vscode'
import { Wizard } from '../../shared/wizards/wizard'
import { createSingleFileDialog } from '../../shared/ui/common/openDialog'

interface ImportExecutionWizardResponse {
    readonly executionFile: vscode.Uri
}

export class ImportExecutionWizard extends Wizard<ImportExecutionWizardResponse> {
    public constructor() {
        super()

        this.form.executionFile.bindPrompter(() =>
            createSingleFileDialog({
                title: localize(
                    'AWS.stepFunctions.importExecutionWizard.selectFile.title',
                    'Select execution file to import'
                ),
                filters: {
                    [localize('AWS.stepFunctions.importExecutionWizard.fileFilter.json', 'JSON Files')]: ['json'],
                    [localize('AWS.stepFunctions.importExecutionWizard.fileFilter.all', 'All Files')]: ['*'],
                },
                openLabel: localize('AWS.stepFunctions.importExecutionWizard.selectFile.openLabel', 'Import Execution'),
            })
        )
    }
}
