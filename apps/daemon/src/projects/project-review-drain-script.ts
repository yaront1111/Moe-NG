export const PROJECT_REVIEW_DRAIN_SCRIPT = `$ErrorActionPreference='Stop'
$ready=$false
try {
 $wire=[Console]::In.ReadLine() | ConvertFrom-Json
 Add-Type -TypeDefinition ([string]$wire.nativeSource)
 $ready=$true
 [Console]::Out.WriteLine('{"ready":true}')
 if([Console]::In.ReadLine() -ne 'DRAIN') { return }
 $request=$wire.input
 $evidence=[MoeReviewDrain]::Drain([uint32]$request.controllerPid,[string]$request.notStartedAfter,[string]$request.workspace)
 [Console]::Out.WriteLine((@{ok=$true;evidence=$evidence}|ConvertTo-Json -Compress))
 if([MoeReviewDrain]::Hold()) { [MoeReviewDrain]::Close(); [Console]::Out.WriteLine('{"closed":true}') }
} catch {
 $errorObject=$_.Exception
 while($errorObject.InnerException) { $errorObject=$errorObject.InnerException }
 $known='MoeDrainFailure' -as [type]
 $failure=@{ok=$false;code='RUNTIME_REVIEW_DRAIN_UNAVAILABLE'}
 if($known -and $errorObject -is $known) { $failure.code=$errorObject.Code; if($errorObject.Reason){$failure.reason=[string]$errorObject.Reason} }
 elseif($ready) { $failure.code='RUNTIME_REVIEW_DRAIN_UNPROVEN' }
 [Console]::Out.WriteLine(($failure|ConvertTo-Json -Compress))
} finally { if('MoeReviewDrain' -as [type]){[MoeReviewDrain]::Close()} }
`;
