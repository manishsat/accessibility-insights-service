// Copyright (c) Microsoft Corporation. All rights reserved.
// Licensed under the MIT License.
import 'reflect-metadata';

import { Context } from '@azure/functions';
import { BlobContentDownloadResponse } from 'azure-services';
import { GuidGenerator, ServiceConfiguration } from 'common';
import { ContextAwareLogger } from 'logger';
import { HttpResponse, PageScanRunReportService, WebApiErrorCodes } from 'service-library';
import { Readable } from 'stream';
import { IMock, It, Mock, Times } from 'typemoq';

import { BodyParser } from './../utils/body-parser';
import { ScanReportController } from './scan-report-controller';

describe(ScanReportController, () => {
    let scanReportController: ScanReportController;
    let context: Context;
    let reportServiceMock: IMock<PageScanRunReportService>;
    let serviceConfigurationMock: IMock<ServiceConfiguration>;
    let contextAwareLoggerMock: IMock<ContextAwareLogger>;
    let guidGeneratorMock: IMock<GuidGenerator>;
    const validId = 'valid-id';
    const notFoundId = 'not-found-id';
    const invalidId = 'invalid-id';
    let contentMock: IMock<NodeJS.ReadableStream>;
    let downloadResponse: BlobContentDownloadResponse;
    let bodyParserMock: IMock<BodyParser>;
    let buffer: Buffer;
    const notFoundDownloadResponse: BlobContentDownloadResponse = {
        notFound: true,
        content: undefined,
    };

    beforeEach(() => {
        context = <Context>(<unknown>{
            req: {
                method: 'GET',
                headers: {},
                rawBody: ``,
                query: {},
            },
            bindingData: {
                reportType: 'html',
            },
        });
        buffer = new Buffer('A chunk of data');
        contentMock = Mock.ofType(Readable);

        bodyParserMock = Mock.ofType(BodyParser);
        bodyParserMock
            .setup(async bpm => bpm.getRawBody(contentMock.object as Readable))
            .returns(async () => buffer)
            .verifiable(Times.once());
        context.req.query['api-version'] = '2.0';
        context.req.headers['content-type'] = 'application/json';
        reportServiceMock = Mock.ofType<PageScanRunReportService>();
        downloadResponse = {
            notFound: false,
            content: contentMock.object,
        };
        reportServiceMock
            // tslint:disable-next-line: no-unsafe-any
            .setup(async rm => rm.readReport(It.isAnyString(), It.isAny()))
            .returns(async id => {
                return id === validId ? downloadResponse : notFoundDownloadResponse;
            });
        guidGeneratorMock = Mock.ofType(GuidGenerator);
        guidGeneratorMock
            .setup(gm => gm.isValidV6Guid(It.isAnyString()))
            .returns(id => {
                return id !== invalidId;
            });

        serviceConfigurationMock = Mock.ofType<ServiceConfiguration>();

        contextAwareLoggerMock = Mock.ofType<ContextAwareLogger>();
    });

    function createScanResultController(contextReq: Context): ScanReportController {
        const controller = new ScanReportController(
            reportServiceMock.object,
            guidGeneratorMock.object,
            serviceConfigurationMock.object,
            contextAwareLoggerMock.object,
            bodyParserMock.object,
        );
        controller.context = contextReq;

        return controller;
    }

    describe('invoke', () => {
        it('should return 400 if request id is invalid', async () => {
            context.bindingData.reportId = invalidId;
            scanReportController = createScanResultController(context);

            await scanReportController.invoke(context);

            const expectedResponse = HttpResponse.getErrorResponse(WebApiErrorCodes.invalidResourceId);
            expect(context.res.status).toEqual(expectedResponse.status);
            expect(context.res.body).toEqual(expectedResponse.body);
        });

        it('should return 404 if report not found', async () => {
            context.bindingData.reportId = notFoundId;
            scanReportController = createScanResultController(context);

            await scanReportController.invoke(context);

            expect(context.res.status).toEqual(404);
        });

        it('should return stream', async () => {
            context.bindingData.reportId = validId;
            scanReportController = createScanResultController(context);

            await scanReportController.invoke(context);

            contentMock.verifyAll();
            expect(context.res.status).toEqual(200);
            expect(context.res.body).toEqual(buffer);
        });

        it('should fail on on invalid report type', async () => {
            context.bindingData.reportId = validId;
            context.bindingData.reportType = 'invalid-type';
            scanReportController = createScanResultController(context);

            await scanReportController.invoke(context);

            contentMock.verifyAll();
            const expectedResponse = HttpResponse.getErrorResponse(WebApiErrorCodes.unsupportedReportTypeError);
            expect(context.res.status).toEqual(expectedResponse.status);
            expect(context.res.body).toEqual(expectedResponse.body);
        });

        it('report type should default to sarif', async () => {
            context.bindingData.reportId = validId;
            context.bindingData.reportType = undefined;
            scanReportController = createScanResultController(context);

            // tslint:disable-next-line: no-unsafe-any
            reportServiceMock.setup(async rm => rm.readReport(It.isAny(), 'sarif')).verifiable(Times.once());

            await scanReportController.invoke(context);

            contentMock.verifyAll();
            expect(context.res.status).toEqual(200);
            expect(context.res.body).toEqual(buffer);
        });
    });
});
