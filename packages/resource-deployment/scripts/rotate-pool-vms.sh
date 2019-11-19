#!/bin/bash

# Copyright (c) Microsoft Corporation. All rights reserved.
# Licensed under the MIT License.

set -eo pipefail

exitWithUsageInfo() {
    echo "
Usage: $0 -r <resource group> -s <subscription name or id>
"
    exit 1
}

getBatchAccountName() {
    declare -n refResult=$1

    echo "Fetching batch account name under resource group $resourceGroupName"
    # shellcheck disable=SC2034
    refResult=$(az batch account list --resource-group "$resourceGroupName" --subscription "$subscription" --query "[0].name" -o tsv)
    echo "Found batch account name - $refResult"
}

rotatePoolVms() {
    local batchAccountName
    getBatchAccountName batchAccountName
    # Login into Azure Batch account
    echo "Logging into '$batchAccountName' Azure Batch account"
    az batch account login --name "$batchAccountName" --resource-group "$resourceGroupName"
    echo "Querying job schedules for $batchAccountName"
    batchJobScheduleIds=$(az batch job-schedule list --account-name "$batchAccountName" --subscription "$subscription" --query "[*].id" -o tsv)
    echo "Disabling job schedules for $batchAccountName"
    for jobSchedule in $batchJobScheduleIds; do
        az batch job-schedule disable --job-schedule-id $jobSchedule --account-name "$batchAccountName" --subscription "$subscription"
    done
    echo "Querying Pools ids for $batchAccountName"
    batchPoolIds=$(az batch pool list --account-name "$batchAccountName" --subscription "$subscription" --query "[*].id" -o tsv)
    for poolId in $batchPoolIds; do
        echo "Querying vm count for pool id $poolId"
        vmcount=$(az batch node list --pool-id $poolId --account-name "$batchAccountName" --subscription "$subscription" --query "length([*].id)")
        echo "Resize pool to 0 - $poolId"
        az batch pool resize --pool-id $poolId  --account-name "$batchAccountName" --subscription "$subscription" --target-dedicated-nodes 0
        vmcountAfterResize=$(az batch node list --pool-id $poolId --account-name "$batchAccountName" --subscription "$subscription" --query "length([*].id)")
        while ([ -z "$resourceExists" ] || [ "$resourceExists" = false ]) && [ $SECONDS -le $end ]; do
        sleep 5
        printf "."
        resourceExists=$(eval "$existanceQuery")
        done
    done

}

# Read script arguments
while getopts ":r:s:l:" option; do
    case $option in
    r) resourceGroupName=${OPTARG} ;;
    s) subscription=${OPTARG} ;;
    *) exitWithUsageInfo ;;
    esac
done

if [[ -z $resourceGroupName ]] || [[ -z $subscription ]]; then
    exitWithUsageInfo
fi
