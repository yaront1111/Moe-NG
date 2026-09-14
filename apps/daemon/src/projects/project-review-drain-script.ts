export const PROJECT_REVIEW_DRAIN_SCRIPT = `$ErrorActionPreference='Stop'
try {
 $wire=[Console]::In.ReadLine() | ConvertFrom-Json
 Add-Type -TypeDefinition ([string]$wire.nativeSource)
 $request=$wire.input
 $evidence=[MoeReviewDrain]::Drain([uint32]$request.controllerPid,[string]$request.notStartedAfter,[string]$request.workspace)
 [Console]::Out.WriteLine((@{ok=$true;evidence=$evidence}|ConvertTo-Json -Compress))
 if([MoeReviewDrain]::Hold()) { [MoeReviewDrain]::Close(); [Console]::Out.WriteLine('{"closed":true}') }
} catch {
 $errorObject=$_.Exception
 while($errorObject.InnerException) { $errorObject=$errorObject.InnerException }
 $code=if($errorObject -is [MoeDrainFailure]){$errorObject.Code}else{'RUNTIME_REVIEW_DRAIN_UNPROVEN'}
 [Console]::Out.WriteLine((@{ok=$false;code=$code}|ConvertTo-Json -Compress))
} finally { if('MoeReviewDrain' -as [type]){[MoeReviewDrain]::Close()} }
`;
