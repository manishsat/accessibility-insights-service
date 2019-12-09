// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import { inject, injectable } from 'inversify';
import { Logger } from 'logger';

@injectable()
export class Batch {
    public constructor(
        @inject(webApiJobManagerIocTypeNames.BatchServiceClientProvider) private readonly batchClientProvider: BatchServiceClientProvider,
        @inject(Logger) private readonly logger: Logger,
    ) {}

    public async getTaskRunIntervals(): Promise<number[]> {
        const client = await this.batchClientProvider();
    }
}
