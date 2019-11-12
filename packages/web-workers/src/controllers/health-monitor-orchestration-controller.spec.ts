// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
// tslint:disable: no-submodule-imports no-any
import 'reflect-metadata';

import { RestApiConfig, ServiceConfiguration } from 'common';
import * as durableFunctions from 'durable-functions';
import { DurableOrchestrationContext, IOrchestrationFunctionContext, Task } from 'durable-functions/lib/src/classes';
import { isNil } from 'lodash';
import { ContextAwareLogger } from 'logger';
import { ScanRunResponse } from 'service-library';
import { IMock, It, Mock, Times } from 'typemoq';
import { ActivityAction } from '../contracts/activity-actions';
import { ActivityRequestData, CreateScanRequestData, SerializableResponse } from './activity-request-data';
import { HealthMonitorOrchestrationController } from './health-monitor-orchestration-controller';

// tslint:disable: no-empty no-unsafe-any no-object-literal-type-assertion

describe('HealthMonitorOrchestrationController', () => {
    let testSubject: HealthMonitorOrchestrationController;
    let serviceConfigurationMock: IMock<ServiceConfiguration>;
    let contextAwareLoggerMock: IMock<ContextAwareLogger>;
    let context: IOrchestrationFunctionContext;
    let orchestrationContext: IMock<DurableOrchestrationContext>;
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
    let orchestratorExecutorSteps: IterableIterator<unknown>;

    beforeEach(() => {
        serviceConfigurationMock = Mock.ofType(ServiceConfiguration);
        contextAwareLoggerMock = Mock.ofType(ContextAwareLogger);
        orchestrationContext = Mock.ofType<DurableOrchestrationContext>();

        context = <IOrchestrationFunctionContext>(<unknown>{
            bindingDefinitions: {},
            executionContext: {
                functionName: 'function-name',
                invocationId: 'id',
            },
            bindingData: {
                logger: undefined,
            },
            df: orchestrationContext.object,
        });

        df = Mock.ofType<typeof durableFunctions>(undefined);

        orchestratorGeneratorMock = Mock.ofInstance<(contextObj: IOrchestrationFunctionContext) => void>(() => {});

        orchestrationContext.setup(o => o.isReplaying).returns(() => true);
        orchestrationContext.setup(o => o.instanceId).returns(() => 'df instance id');

        df.setup(d => d.orchestrator(It.isAny()))
            .callback((fn: (context: IOrchestrationFunctionContext) => IterableIterator<unknown>) => {
                orchestratorExecutorSteps = fn(context);
            })
            .returns(() => orchestratorGeneratorMock.object);

        testSubject = new HealthMonitorOrchestrationController(serviceConfigurationMock.object, contextAwareLoggerMock.object, df.object);
    });

    it('does not invoke orchestrator executor on construction', () => {
        expect(orchestratorExecutorSteps).toBeUndefined();
    });

    describe('invoke', () => {
        beforeEach(() => {
            setupServiceConfig();
        });

        it('sets context required for orchestrator execution', async () => {
            await testSubject.invoke(context);
            expect(context.bindingData.controller).toBe(testSubject);
            expect(context.bindingData.scanRequestProcessingDelayInSeconds).toEqual(restApiConfig.scanRequestProcessingDelayInSeconds);
        });

        it('executes orchestrator', async () => {
            await testSubject.invoke(context);

            expect(orchestratorExecutorSteps).toBeDefined();
            orchestratorGeneratorMock.verify(g => g(context), Times.once());
        });

        it('executes activities in sequence', async () => {
            await testSubject.invoke(context);

            let prevCall: IteratorResult<any>;

            prevCall = verifyActivityExecution(ActivityAction.getHealthStatus, undefined, { statusCode: 200 } as SerializableResponse);

            prevCall = verifyActivityExecution(
                ActivityAction.createScanRequest,
                {
                    scanUrl: 'https://www.bing.com',
                    priority: 0,
                } as CreateScanRequestData,
                { statusCode: 200, body: [{ scanId: 'scan id', url: 'https://www.bing.com' } as ScanRunResponse] } as SerializableResponse<
                    ScanRunResponse[]
                >,
                prevCall,
            );

            //verifyActivityExecution(ActivityAction.getScanResult);

            expect(orchestratorExecutorSteps.next(prevCall.value).done).toBe(true);
        });
    });

    function verifyActivityExecution(
        activityName: string,
        inputData?: any,
        activityResult?: any,
        prevCall?: IteratorResult<any>,
    ): IteratorResult<any> {
        orchestrationContext
            .setup(oc => oc.callActivity(activityFuncName, { activityName, data: inputData } as ActivityRequestData))
            .returns(() => activityResult)
            .verifiable(Times.once());

        const nextCall = orchestratorExecutorSteps.next(isNil(prevCall) ? undefined : prevCall.value);
        orchestrationContext.verifyAll();

        expect(nextCall.done).toBe(false);

        return nextCall;
    }

    function setupServiceConfig(): void {
        serviceConfigurationMock.setup(async sc => sc.getConfigValue('restApiConfig')).returns(async () => restApiConfig);
    }
});
