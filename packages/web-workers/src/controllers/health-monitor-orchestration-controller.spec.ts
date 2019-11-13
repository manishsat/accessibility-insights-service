// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
// tslint:disable: no-submodule-imports no-any
import 'reflect-metadata';

import { Context } from '@azure/functions';
import { RestApiConfig, ServiceConfiguration } from 'common';
import * as durableFunctions from 'durable-functions';
import { DurableOrchestrationContext, IOrchestrationFunctionContext, Task } from 'durable-functions/lib/src/classes';
import { isNil } from 'lodash';
import { ContextAwareLogger } from 'logger';
import { ScanRunResponse, ScanRunResultResponse } from 'service-library';
import { IMock, It, Mock, Times } from 'typemoq';
import { ActivityAction } from '../contracts/activity-actions';
import { OrchestrationSteps, OrchestrationStepsImpl } from '../orchestration-steps';
import { GeneratorExecutor } from '../test-utilities/generator-executor';
import { ActivityRequestData, CreateScanRequestData, SerializableResponse } from './activity-request-data';
import { HealthMonitorOrchestrationController } from './health-monitor-orchestration-controller';

// tslint:disable: no-empty no-unsafe-any no-object-literal-type-assertion

class TestableHealthMonitorOrchestrationController extends HealthMonitorOrchestrationController {
    public orchestrationStepsCreated: boolean = false;

    constructor(
        public orchestrationStepsStub: OrchestrationStepsStub,
        public context: Context,
        public restApiConfig: RestApiConfig,
        serviceConfig: ServiceConfiguration,
        contextAwareLogger: ContextAwareLogger,
        df: typeof durableFunctions,
    ) {
        super(serviceConfig, contextAwareLogger, df);
    }

    protected createOrchestrationSteps(context: IOrchestrationFunctionContext, restApiConfig: RestApiConfig): OrchestrationSteps {
        expect(context).toBe(this.context);
        expect(restApiConfig).toBe(this.restApiConfig);
        this.orchestrationStepsCreated = true;

        return this.orchestrationStepsStub;
    }
}

export interface OrchestratorStepsCallCount {
    callHealthCheckCount: number;
    getScanReportCount: number;
    waitForScanCompletionCount: number;
    verifyScanSubmittedCount: number;
    callSubmitScanRequest: number;
}

class OrchestrationStepsStub implements OrchestrationSteps {
    public orchestratorStepsCallCount: OrchestratorStepsCallCount = {
        callHealthCheckCount: 0,
        getScanReportCount: 0,
        waitForScanCompletionCount: 0,
        verifyScanSubmittedCount: 0,
        callSubmitScanRequest: 0,
    };

    public scanId = 'scan-id';
    public reportId = 'report-id';
    public shouldThrowException = false;

    public *callHealthCheckActivity(): Generator<Task, void, SerializableResponse> {
        this.orchestratorStepsCallCount.callHealthCheckCount += 1;
        this.throwExceptionIfExpected();
        yield undefined;
    }

    public *getScanReport(scanId: string, reportId: string): Generator<Task, void, SerializableResponse & void> {
        this.orchestratorStepsCallCount.getScanReportCount += 1;
        this.throwExceptionIfExpected();
        expect(scanId).toBe(this.scanId);
        expect(reportId).toBe(this.reportId);

        yield undefined;
    }

    public *waitForScanCompletion(scanId: string): Generator<any, ScanRunResultResponse, any> {
        this.orchestratorStepsCallCount.waitForScanCompletionCount += 1;
        this.throwExceptionIfExpected();
        expect(scanId).toBe(this.scanId);

        const scanRunResultResponse = {
            scanId: 'scanId',
            url: 'url',
            reports: [
                {
                    reportId: this.reportId,
                },
            ],
            run: {
                state: 'completed',
            },
        } as ScanRunResultResponse;

        return yield scanRunResultResponse;
    }

    public *verifyScanSubmitted(scanId: string): Generator<Task, void, SerializableResponse & void> {
        this.orchestratorStepsCallCount.verifyScanSubmittedCount += 1;
        this.throwExceptionIfExpected();
        expect(scanId).toBe(this.scanId);

        yield undefined;
    }

    public *callSubmitScanRequestActivity(url: string): Generator<any, string, any> {
        this.orchestratorStepsCallCount.callSubmitScanRequest += 1;
        this.throwExceptionIfExpected();
        expect(url).toBe('https://www.bing.com');

        return yield this.scanId;
    }

    private throwExceptionIfExpected(): void {
        if (this.shouldThrowException) {
            throw new Error('test error at orchestration step');
        }
    }
}

describe('HealthMonitorOrchestrationController', () => {
    let testSubject: TestableHealthMonitorOrchestrationController;
    let serviceConfigurationMock: IMock<ServiceConfiguration>;
    let contextAwareLoggerMock: IMock<ContextAwareLogger>;
    let contextStub: IOrchestrationFunctionContext;
    let df: IMock<typeof durableFunctions>;
    const restApiConfig: RestApiConfig = {
        maxScanRequestBatchCount: 10,
        scanRequestProcessingDelayInSeconds: 20,
        maxScanRequestWaitTimeInSeconds: 30,
        minScanPriorityValue: 40,
        maxScanPriorityValue: 50,
    };
    const activityFuncName = 'health-monitor-client-func';
    let orchestratorGeneratorMock: IMock<(ctxt: IOrchestrationFunctionContext) => void>;
    let orchestratorStepsStub: OrchestrationStepsStub;
    let orchestratorIterator: GeneratorExecutor;

    beforeEach(() => {
        serviceConfigurationMock = Mock.ofType(ServiceConfiguration);
        contextAwareLoggerMock = Mock.ofType(ContextAwareLogger);
        orchestratorStepsStub = new OrchestrationStepsStub();

        contextStub = ({
            bindingData: {},
            executionContext: {
                functionName: 'function-name',
                invocationId: 'id',
            },
        } as unknown) as IOrchestrationFunctionContext;

        df = Mock.ofType<typeof durableFunctions>(undefined);

        orchestratorGeneratorMock = Mock.ofInstance<(contextObj: IOrchestrationFunctionContext) => void>(() => {});

        df.setup(d => d.orchestrator(It.isAny()))
            .callback((fn: (context: IOrchestrationFunctionContext) => IterableIterator<unknown>) => {
                orchestratorIterator = new GeneratorExecutor(fn(contextStub));
            })
            .returns(() => orchestratorGeneratorMock.object);

        testSubject = new TestableHealthMonitorOrchestrationController(
            orchestratorStepsStub,
            contextStub,
            restApiConfig,
            serviceConfigurationMock.object,
            contextAwareLoggerMock.object,
            df.object,
        );
    });

    it('does not invoke orchestrator executor on construction', () => {
        expect(orchestratorIterator).toBeUndefined();
    });

    describe('invoke', () => {
        beforeEach(() => {
            setupServiceConfig();
        });

        it('should use context passed by orchestrator', async () => {
            const newRestApiConfig = { ...restApiConfig };
            newRestApiConfig.maxScanPriorityValue += 1;

            const orchestrationFuncContext = ({
                bindingData: {
                    controller: testSubject,
                    restApiConfig: newRestApiConfig,
                },
            } as unknown) as IOrchestrationFunctionContext;

            df.reset();
            df.setup(d => d.orchestrator(It.isAny()))
                .callback((fn: (context: IOrchestrationFunctionContext) => IterableIterator<unknown>) => {
                    orchestratorIterator = new GeneratorExecutor(fn(orchestrationFuncContext));
                })
                .returns(() => orchestratorGeneratorMock.object);

            await testSubject.invoke(contextStub);

            testSubject.context = orchestrationFuncContext;
            testSubject.restApiConfig = newRestApiConfig;

            orchestratorIterator.next();

            expect(testSubject.orchestrationStepsCreated).toBe(true);
        });

        it('sets context required for orchestrator execution', async () => {
            await testSubject.invoke(contextStub);
            expect(contextStub.bindingData.controller).toBe(testSubject);
            expect(contextStub.bindingData.restApiConfig).toEqual(restApiConfig);
        });

        it('executes orchestrator', async () => {
            await testSubject.invoke(contextStub);

            expect(orchestratorIterator).toBeDefined();
            orchestratorGeneratorMock.verify(g => g(contextStub), Times.once());
        });

        it('executes activities in sequence', async () => {
            const expectedStepsCallCount: OrchestratorStepsCallCount = {
                callHealthCheckCount: 0,
                callSubmitScanRequest: 0,
                getScanReportCount: 0,
                verifyScanSubmittedCount: 0,
                waitForScanCompletionCount: 0,
            };

            const actualStepsCallCount: OrchestratorStepsCallCount = orchestratorStepsStub.orchestratorStepsCallCount;

            await testSubject.invoke(contextStub);

            orchestratorIterator.next();
            expectedStepsCallCount.callHealthCheckCount += 1;
            expect(actualStepsCallCount).toEqual(expectedStepsCallCount);

            orchestratorIterator.next();
            expectedStepsCallCount.callSubmitScanRequest += 1;
            expect(actualStepsCallCount).toEqual(expectedStepsCallCount);

            orchestratorIterator.next();
            expectedStepsCallCount.verifyScanSubmittedCount += 1;
            expect(actualStepsCallCount).toEqual(expectedStepsCallCount);

            orchestratorIterator.next();
            expectedStepsCallCount.waitForScanCompletionCount += 1;
            expect(actualStepsCallCount).toEqual(expectedStepsCallCount);

            orchestratorIterator.next();
            expectedStepsCallCount.getScanReportCount += 1;
            expect(actualStepsCallCount).toEqual(expectedStepsCallCount);

            expect(orchestratorIterator.next().done).toBe(true);
            expect(actualStepsCallCount).toEqual(expectedStepsCallCount);
        });

        test.each([0, 1, 2, 3, 4])('activities throw exception on step %o', async failedStep => {
            await testSubject.invoke(contextStub);

            for (let stepNum = 0; stepNum < failedStep; stepNum += 1) {
                orchestratorIterator.next();
            }

            orchestratorStepsStub.shouldThrowException = true;

            expect(() => {
                orchestratorIterator.next();
            }).toThrowError();

            expect(orchestratorIterator.next().done).toBe(true);
        });
    });

    function setupServiceConfig(): void {
        serviceConfigurationMock.setup(async sc => sc.getConfigValue('restApiConfig')).returns(async () => restApiConfig);
    }
});
