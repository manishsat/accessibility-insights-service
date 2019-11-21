// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import { GuidGenerator, RestApiConfig, ServiceConfiguration, Url } from 'common';
import { inject, injectable } from 'inversify';
import { isNil } from 'lodash';
import { BatchScanRequestMeasurements, ContextAwareLogger, Logger } from 'logger';
import {
    ApiController,
    HttpResponse,
    OnDemandPageScanRunResultProvider,
    PageScanRequestProvider,
    PartitionKeyFactory,
    ScanDataProvider,
    ScanRunRequest,
    ScanRunResponse,
    WebApiError,
    WebApiErrorCodes,
} from 'service-library';
import { ItemType, OnDemandPageScanRequest, OnDemandPageScanResult, PartitionKey, ScanRunBatchRequest } from 'storage-documents';

// tslint:disable: no-any
type DictionaryStringToNumber = { [name: string]: number };

interface ProcessedBatchRequestData {
    scanRequestToBeStoredInDb: ScanRunBatchRequest;
    scanResponse: ScanRunResponse;
}

interface RunRequestValidationResult {
    valid: boolean;
    error?: WebApiError;
}

@injectable()
export class ScanRequestController extends ApiController {
    public readonly apiVersion = '1.0';
    public readonly apiName = 'web-api-post-scans';
    private config: RestApiConfig;

    public constructor(
        @inject(ScanDataProvider) private readonly scanDataProvider: ScanDataProvider,
        @inject(GuidGenerator) private readonly guidGenerator: GuidGenerator,
        @inject(ServiceConfiguration) protected readonly serviceConfig: ServiceConfiguration,
        @inject(ContextAwareLogger) contextAwareLogger: ContextAwareLogger,
        @inject(PartitionKeyFactory) private readonly partitionKeyFactory: PartitionKeyFactory,
        @inject(OnDemandPageScanRunResultProvider) private readonly onDemandPageScanRunResultProvider: OnDemandPageScanRunResultProvider,
        @inject(PageScanRequestProvider) private readonly pageScanRequestProvider: PageScanRequestProvider,
    ) {
        super(contextAwareLogger);
    }

    public async handleRequest(): Promise<void> {
        await this.init();
        let payload: ScanRunRequest[];
        try {
            payload = this.extractPayload();
        } catch (e) {
            this.context.res = HttpResponse.getErrorResponse(WebApiErrorCodes.malformedRequest);

            return;
        }

        if (payload.length > this.config.maxScanRequestBatchCount) {
            this.context.res = HttpResponse.getErrorResponse(WebApiErrorCodes.requestBodyTooLarge);

            return;
        }
        const batchId = this.guidGenerator.createGuid();
        const processedData = this.getProcessedRequestData(batchId, payload[0]);

        await this.writeRequestsToPermanentContainer(processedData.scanRequestToBeStoredInDb);
        await this.writeRequestsToQueueContainer(processedData.scanRequestToBeStoredInDb);

        this.context.res = {
            status: 202, // Accepted
            body: this.getResponse(processedData),
        };

        const totalUrls: number = 1;
        const invalidUrls: number = processedData.scanResponse.error !== undefined ? 1 : 0;

        this.contextAwareLogger.setCustomProperties({ scanId: processedData.scanResponse.scanId, scanUrl: processedData.scanResponse.url });
        this.contextAwareLogger.logInfo('Accepted scan run batch request', {
            totalUrls: totalUrls.toString(),
            invalidUrls: invalidUrls.toString(),
            scanRequestResponse: JSON.stringify(processedData.scanResponse),
        });

        const measurements: BatchScanRequestMeasurements = {
            totalScanRequests: totalUrls,
            acceptedScanRequests: totalUrls - invalidUrls,
            rejectedScanRequests: invalidUrls,
        };

        // tslint:disable-next-line: no-null-keyword
        this.contextAwareLogger.trackEvent('BatchScanRequestSubmitted', null, measurements);
    }

    private async writeRequestsToPermanentContainer(request: ScanRunBatchRequest): Promise<void> {
        const requestDocument: OnDemandPageScanResult = {
            id: request.scanId,
            url: request.url,
            priority: request.priority,
            itemType: ItemType.onDemandPageScanRunResult,
            partitionKey: this.partitionKeyFactory.createPartitionKeyForDocument(ItemType.onDemandPageScanRunResult, request.scanId),
            run: {
                state: 'accepted',
                timestamp: new Date().toJSON(),
            },
            batchRequestId: request.scanId,
        };

        await this.onDemandPageScanRunResultProvider.writeScanRuns([requestDocument]);

        this.contextAwareLogger.logInfo(`[ScanRequestController] Added requests to permanent container`);
    }

    private async writeRequestsToQueueContainer(request: ScanRunBatchRequest): Promise<void> {
        const requestDocument: OnDemandPageScanRequest = {
            id: request.scanId,
            url: request.url,
            priority: request.priority,
            itemType: ItemType.onDemandPageScanRequest,
            partitionKey: PartitionKey.pageScanRequestDocuments,
        };

        await this.pageScanRequestProvider.insertRequests([requestDocument]);
        this.contextAwareLogger.logInfo(`[ScanRequestController] Added requests to queue container`);
    }

    private getResponse(processedData: ProcessedBatchRequestData): any {
        const isV2 = this.context.req.query['api-version'] === '2.0' ? true : false;
        let response;
        if (isV2) {
            response = processedData.scanResponse;
        } else {
            response = [processedData.scanResponse];
        }

        return response;
    }

    private extractPayload(): ScanRunRequest[] {
        const isV2 = this.context.req.query['api-version'] === '2.0';
        let payload: ScanRunRequest[];
        if (isV2) {
            const singularReq: ScanRunRequest = this.tryGetPayload<ScanRunRequest>();
            if (Array.isArray(singularReq)) {
                throw new Error('Malformed request body');
            }
            payload = [singularReq];
        } else {
            payload = this.tryGetPayload<ScanRunRequest[]>();
        }

        return payload;
    }

    private getProcessedRequestData(batchId: string, scanRunRequest: ScanRunRequest): ProcessedBatchRequestData {
        let scanRequestToBeStoredInDb: ScanRunBatchRequest;
        let scanResponse: ScanRunResponse;

        const runRequestValidationResult = this.validateRunRequest(scanRunRequest);
        if (runRequestValidationResult.valid) {
            // preserve GUID origin for a single batch scope
            const scanId = this.guidGenerator.createGuidFromBaseGuid(batchId);
            scanRequestToBeStoredInDb = {
                scanId: scanId,
                priority: isNil(scanRunRequest.priority) ? 0 : scanRunRequest.priority,
                url: scanRunRequest.url,
            };

            scanResponse = {
                scanId: scanId,
                url: scanRunRequest.url,
            };
        } else {
            scanResponse = {
                url: scanRunRequest.url,
                error: runRequestValidationResult.error,
            };
        }

        return {
            scanRequestToBeStoredInDb: scanRequestToBeStoredInDb,
            scanResponse: scanResponse,
        };
    }

    private validateRunRequest(scanRunRequest: ScanRunRequest): RunRequestValidationResult {
        if (Url.tryParseUrlString(scanRunRequest.url) === undefined) {
            return { valid: false, error: WebApiErrorCodes.invalidURL.error };
        }

        if (scanRunRequest.priority < this.config.minScanPriorityValue || scanRunRequest.priority > this.config.maxScanPriorityValue) {
            return { valid: false, error: WebApiErrorCodes.outOfRangePriority.error };
        }

        return { valid: true };
    }

    private async init(): Promise<void> {
        this.config = await this.getRestApiConfig();
    }
}
