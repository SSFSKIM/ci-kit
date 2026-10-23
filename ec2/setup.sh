#!/usr/bin/env bash
# M1 only. Existing setup is left unchanged; IAM trust is based on a real Google ID token.
set -euo pipefail
export AWS_PROFILE=${AWS_PROFILE:-ci-kit-ops} AWS_REGION=${AWS_REGION:-us-east-2} AWS_PAGER=''
[[ "$AWS_PROFILE" == ci-kit-ops && "$AWS_REGION" == us-east-2 ]]
[[ $(aws sts get-caller-identity --query Account --output text) == 290475840169 ]]
tags='[{"Key":"ci-kit-pool","Value":"ec2-spike"},{"Key":"ci-kit-purpose","Value":"spike"}]'
if ! aws iam get-role --role-name AWSServiceRoleForEC2Spot >/dev/null 2>&1; then
  aws iam create-service-linked-role --aws-service-name spot.amazonaws.com
fi
vpc=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)
sg=$(aws ec2 describe-security-groups --filters "Name=vpc-id,Values=$vpc" Name=group-name,Values=ci-kit-pool --query 'SecurityGroups[0].GroupId' --output text)
if [[ "$sg" == None ]]; then
  sg=$(aws ec2 create-security-group --group-name ci-kit-pool --description 'ci-kit outbound-only pool' --vpc-id "$vpc" --tag-specifications "[{\"ResourceType\":\"security-group\",\"Tags\":$tags}]" --query GroupId --output text)
fi
printf 'security_group=%s\n' "$sg"
# A service-linked role cannot carry user tags. All taggable setup resources carry both spike tags.
if [[ -n ${SPIKE_TRUST_FILE:-} ]] && ! aws iam get-role --role-name ci-kit-ec2-spike >/dev/null 2>&1; then
  aws iam create-role --role-name ci-kit-ec2-spike --max-session-duration 14400 --assume-role-policy-document "file://$SPIKE_TRUST_FILE" --tags "$tags"
  aws iam put-role-policy --role-name ci-kit-ec2-spike --policy-name describe-only --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"ec2:DescribeAvailabilityZones","Resource":"*","Condition":{"StringEquals":{"aws:RequestedRegion":"us-east-2"}}}]}'
fi
