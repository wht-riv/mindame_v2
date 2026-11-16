param()

Add-Type -TypeDefinition @'
using System;
using System.IO;
using System.Security.Cryptography;

public class Pkcs8RsaExporter {
    public static RSACryptoServiceProvider DecodePkcs8(byte[] pkcs8) {
        using (var mem = new MemoryStream(pkcs8))
        using (var bin = new BinaryReader(mem)) {
            byte b = bin.ReadByte();
            if (b != 0x30) throw new Exception("Not a sequence");
            ReadLength(bin);

            ReadInteger(bin); // version
            b = bin.ReadByte();
            if (b != 0x30) throw new Exception("Expected AlgorithmIdentifier");
            int algLen = ReadLength(bin);
            bin.ReadBytes(algLen);

            b = bin.ReadByte();
            if (b != 0x04) throw new Exception("Expected Octet String");
            int octetLen = ReadLength(bin);
            byte[] pkcs1 = bin.ReadBytes(octetLen);

            return DecodePkcs1(pkcs1);
        }
    }

    private static RSACryptoServiceProvider DecodePkcs1(byte[] pkcs1) {
        using (var mem = new MemoryStream(pkcs1))
        using (var bin = new BinaryReader(mem)) {
            byte b = bin.ReadByte();
            if (b != 0x30) throw new Exception("Not a sequence");
            ReadLength(bin);

            ReadInteger(bin); // version
            byte[] modulus = ReadBytes(bin);
            byte[] exponent = ReadBytes(bin);
            byte[] d = ReadBytes(bin);
            byte[] p = ReadBytes(bin);
            byte[] q = ReadBytes(bin);
            byte[] dp = ReadBytes(bin);
            byte[] dq = ReadBytes(bin);
            byte[] iq = ReadBytes(bin);

            CspParameters csp = new CspParameters();
            csp.Flags = CspProviderFlags.UseMachineKeyStore;
            RSACryptoServiceProvider rsa = new RSACryptoServiceProvider(csp);
            RSAParameters rsaParams = new RSAParameters();
            rsaParams.Modulus = Align(modulus, 256);
            rsaParams.Exponent = exponent;
            rsaParams.D = Align(d, 256);
            rsaParams.P = Align(p, 128);
            rsaParams.Q = Align(q, 128);
            rsaParams.DP = Align(dp, 128);
            rsaParams.DQ = Align(dq, 128);
            rsaParams.InverseQ = Align(iq, 128);
            rsa.ImportParameters(rsaParams);
            return rsa;
        }
    }

    private static byte[] Align(byte[] input, int length) {
        if (input.Length == length) return input;
        if (input.Length > length) {
            byte[] res = new byte[length];
            Buffer.BlockCopy(input, input.Length - length, res, 0, length);
            return res;
        } else {
            byte[] res = new byte[length];
            Buffer.BlockCopy(input, 0, res, length - input.Length, input.Length);
            return res;
        }
    }

    private static int ReadLength(BinaryReader bin) {
        byte b = bin.ReadByte();
        if ((b & 0x80) == 0) return b;
        int count = b & 0x7F;
        int len = 0;
        for (int i = 0; i < count; i++) {
            len = (len << 8) | bin.ReadByte();
        }
        return len;
    }

    private static int ReadInteger(BinaryReader bin) {
        byte b = bin.ReadByte();
        if (b != 0x02) throw new Exception("Expected Integer");
        int len = ReadLength(bin);
        int val = 0;
        for (int i = 0; i < len; i++) {
            val = (val << 8) | bin.ReadByte();
        }
        return val;
    }

    private static byte[] ReadBytes(BinaryReader bin) {
        byte b = bin.ReadByte();
        if (b != 0x02) throw new Exception("Expected Integer bytes");
        int len = ReadLength(bin);
        byte[] bytes = bin.ReadBytes(len);
        if (bytes.Length > 0 && bytes[0] == 0x00) {
            byte[] trimmed = new byte[bytes.Length - 1];
            Buffer.BlockCopy(bytes, 1, trimmed, 0, trimmed.Length);
            return trimmed;
        }
        return bytes;
    }
}
'@

function Base64UrlEncode([byte[]]$bytes) {
    [Convert]::ToBase64String($bytes).Replace('+', '-').Replace('/', '_').TrimEnd('=')
}

function Get-AccessToken($sa) {
    $headerJson = '{"alg":"RS256","typ":"JWT"}'
    $headerBytes = [System.Text.Encoding]::UTF8.GetBytes($headerJson)
    $headerBase64 = Base64UrlEncode $headerBytes

    $now = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds()
    $exp = $now + 3600

    $claimsObj = @{
        iss = $sa.client_email
        scope = "https://www.googleapis.com/auth/datastore"
        aud = "https://oauth2.googleapis.com/token"
        exp = $exp
        iat = $now
    }
    $claimsJson = $claimsObj | ConvertTo-Json -Compress
    $claimsBytes = [System.Text.Encoding]::UTF8.GetBytes($claimsJson)
    $claimsBase64 = Base64UrlEncode $claimsBytes

    $unsignedToken = "$headerBase64.$claimsBase64"
    $unsignedBytes = [System.Text.Encoding]::UTF8.GetBytes($unsignedToken)

    $pkcs8Pem = $sa.private_key
    $pkcs8Base64 = $pkcs8Pem.Replace("-----BEGIN PRIVATE KEY-----", "").Replace("-----END PRIVATE KEY-----", "").Replace("`r", "").Replace("`n", "").Trim()
    $pkcs8Bytes = [Convert]::FromBase64String($pkcs8Base64)

    $rsa = [Pkcs8RsaExporter]::DecodePkcs8($pkcs8Bytes)

    $hasher = [System.Security.Cryptography.SHA256]::Create()
    $hash = $hasher.ComputeHash($unsignedBytes)
    $sigBytes = $rsa.SignHash($hash, "2.16.840.1.101.3.4.2.1")
    $sigBase64 = Base64UrlEncode $sigBytes

    $jwt = "$unsignedToken.$sigBase64"

    $body = @{
        grant_type = "urn:ietf:params:oauth:grant-type:jwt-bearer"
        assertion = $jwt
    }
    $tokenResponse = Invoke-RestMethod -Uri "https://oauth2.googleapis.com/token" -Method Post -Body $body -ContentType "application/x-www-form-urlencoded"
    return $tokenResponse.access_token
}

function Get-FsField($fields, $name) {
    if ($null -eq $fields -or $null -eq $fields.$name) { return "" }
    $f = $fields.$name
    if ($f.stringValue -ne $null) { return $f.stringValue }
    if ($f.integerValue -ne $null) { return [string]$f.integerValue }
    if ($f.doubleValue -ne $null) { return [string]$f.doubleValue }
    if ($f.booleanValue -ne $null) { return [string]$f.booleanValue }
    if ($f.timestampValue -ne $null) {
        try {
            $dt = [DateTimeOffset]::Parse($f.timestampValue).ToOffset([TimeSpan]::FromHours(9))
            return $dt.ToString("yyyy-MM-ddTHH:mm:ss+09:00")
        } catch {
            return $f.timestampValue
        }
    }
    return ""
}

function Format-JstDate($val) {
    if ([string]::IsNullOrWhiteSpace($val)) { return "" }
    try {
        $dt = [DateTimeOffset]::Parse($val).ToOffset([TimeSpan]::FromHours(9))
        return $dt.ToString("yyyy-MM-ddTHH:mm:ss+09:00")
    } catch {
        return $val
    }
}

function Normalize-Outcome($s) {
    if ($s -eq 'done' -or $s -eq 'acted') { return 'done' }
    if ($s -eq 'partial') { return 'partial' }
    if ($s -eq 'not_started' -or $s -eq 'not_done') { return 'not_started' }
    return ''
}

function Get-JstDateTime($val) {
    if ([string]::IsNullOrWhiteSpace($val)) { return $null }
    try {
        return [DateTimeOffset]::Parse($val).ToOffset([TimeSpan]::FromHours(9)).DateTime
    } catch {
        return $null
    }
}

# 4:00境界の生活日 (JST) YYYY-MM-DD
function Get-LifeDate($dt) {
    if ($null -eq $dt) { return "" }
    $shifted = $dt.AddHours(-4)
    return $shifted.ToString("yyyy-MM-dd")
}

function Get-NextDay($ymd) {
    if ([string]::IsNullOrWhiteSpace($ymd)) { return "" }
    try {
        $parts = $ymd.Trim().Split('-')
        $d = [DateTime]::new([int]$parts[0], [int]$parts[1], [int]$parts[2])
        return $d.AddDays(1).ToString("yyyy-MM-dd")
    } catch {
        return ""
    }
}

# 再利用成功: not_started の翌生活日に、振り返りを完了し、新しい作戦を登録した
function Test-ReusedNextLifeDay($rec, $allRecs) {
    $outcomeNorm = Normalize-Outcome $rec.outcomeStatus
    if ($outcomeNorm -ne 'not_started' -or [string]::IsNullOrWhiteSpace($rec.recordDate)) {
        return ""
    }
    $reviewedStr = if (-not [string]::IsNullOrWhiteSpace($rec.reviewCompletedAt)) { $rec.reviewCompletedAt } else { $rec.reviewedAt }
    $reviewedDt = Get-JstDateTime $reviewedStr
    if ($null -eq $reviewedDt) { return "" }

    $next = Get-NextDay $rec.recordDate
    if ([string]::IsNullOrWhiteSpace($next)) { return "" }

    $reviewedLifeDate = Get-LifeDate $reviewedDt
    if ($reviewedLifeDate -ne $next) {
        return "FALSE"
    }

    $planned = $false
    foreach ($r in $allRecs) {
        if ($r.recordDate -eq $next -and (-not [string]::IsNullOrWhiteSpace($r.planCompletedAt) -or -not [string]::IsNullOrWhiteSpace($r.createdAt))) {
            $planned = $true
            break
        }
    }
    if ($planned) { return "TRUE" } else { return "FALSE" }
}

function Escape-CsvVal($val) {
    if ($null -eq $val) { return '' }
    $s = [string]$val
    if ($s.Contains(',') -or $s.Contains('"') -or $s.Contains("`n") -or $s.Contains("`r")) {
        return '"' + $s.Replace('"', '""') + '"'
    }
    return $s
}

$sa = Get-Content serviceAccountKey.json -Raw | ConvertFrom-Json
$token = Get-AccessToken $sa
$headers = @{ Authorization = "Bearer $token" }
$baseApi = "https://firestore.googleapis.com/v1/projects/$($sa.project_id)/databases/(default)/documents"

# --- 1. Export participantsV4 & records ---
Write-Host "Fetching participantsV4..."
$partDocs = @()
$pageToken = ""
do {
    $url = "$baseApi/participantsV4?pageSize=100"
    if ($pageToken) { $url += "&pageToken=$pageToken" }
    $resp = Invoke-RestMethod -Uri $url -Method Get -Headers $headers
    if ($resp.documents) { $partDocs += $resp.documents }
    $pageToken = $resp.nextPageToken
} while ($pageToken)

Write-Host "Found $($partDocs.Count) participants."

$recordHeaders = @(
    'participantCode',
    'uid',
    'appVersion',
    'recordDate',
    'lifeDayStart',
    'dailyIntentionText',
    'dailyIntentionSource',
    'goalText',
    'predictedExcuse',
    'excuseSource',
    'firstStepText',
    'stepSource',
    'outcomeStatus',
    'outcomeNormalized',
    'predictionMatched',
    'actualExcuse',
    'actualExcuseSource',
    'selfBlameScore',
    'createdAt',
    'reviewedAt',
    'sessionStartedAt',
    'planStartedAt',
    'planCompletedAt',
    'reviewStartedAt',
    'reviewCompletedAt',
    'sessionDurationSeconds',
    'reviewAvailableAt',
    'reusedNextLifeDay'
)

$recordRows = @()

foreach ($pDoc in $partDocs) {
    $uid = $pDoc.name.Split('/')[-1]
    $pFields = $pDoc.fields
    $pCode = Get-FsField $pFields 'participantCode'
    $pVer = Get-FsField $pFields 'appVersion'

    # Fetch records subcollection
    $pRecordList = @()
    $recPageToken = ""
    do {
        $recUrl = "https://firestore.googleapis.com/v1/$($pDoc.name)/records?pageSize=100"
        if ($recPageToken) { $recUrl += "&pageToken=$recPageToken" }
        try {
            $recResp = Invoke-RestMethod -Uri $recUrl -Method Get -Headers $headers
            if ($recResp.documents) {
                foreach ($rDoc in $recResp.documents) {
                    $rFields = $rDoc.fields

                    $participantCode = Get-FsField $rFields 'participantCode'
                    if (-not $participantCode) { $participantCode = $pCode }

                    $uidVal = Get-FsField $rFields 'ownerUid'
                    if (-not $uidVal) { $uidVal = $uid }

                    $appVer = Get-FsField $rFields 'appVersion'
                    if (-not $appVer) { $appVer = $pVer }

                    $recordDate = Get-FsField $rFields 'recordDate'

                    $lifeDayStart = Format-JstDate (Get-FsField $rFields 'lifeDayStart')
                    if (-not $lifeDayStart) { $lifeDayStart = $recordDate }

                    $dailyIntentionText = Get-FsField $rFields 'dailyIntentionText'
                    if (-not $dailyIntentionText) { $dailyIntentionText = Get-FsField $rFields 'goalText' }

                    $dailyIntentionSource = Get-FsField $rFields 'dailyIntentionSource'
                    if (-not $dailyIntentionSource) { $dailyIntentionSource = Get-FsField $rFields 'intentionSource' }

                    $goalText = Get-FsField $rFields 'goalText'
                    $predictedExcuse = Get-FsField $rFields 'predictedExcuse'
                    $excuseSource = Get-FsField $rFields 'excuseSource'
                    $firstStepText = Get-FsField $rFields 'firstStepText'
                    $stepSource = Get-FsField $rFields 'stepSource'
                    $outcomeStatus = Get-FsField $rFields 'outcomeStatus'
                    $outcomeNormalized = Normalize-Outcome $outcomeStatus
                    $predictionMatched = Get-FsField $rFields 'predictionMatched'
                    $actualExcuse = Get-FsField $rFields 'actualExcuse'
                    $actualExcuseSource = Get-FsField $rFields 'actualExcuseSource'

                    $selfBlameScore = Get-FsField $rFields 'selfBlameAfterNotStarted'
                    if ($selfBlameScore -eq "") { $selfBlameScore = Get-FsField $rFields 'selfBlameScore' }

                    $createdAt = Format-JstDate (Get-FsField $rFields 'createdAt')
                    $reviewedAt = Format-JstDate (Get-FsField $rFields 'reviewedAt')
                    $sessionStartedAt = Format-JstDate (Get-FsField $rFields 'sessionStartedAt')
                    $planStartedAt = Format-JstDate (Get-FsField $rFields 'planStartedAt')
                    $planCompletedAt = Format-JstDate (Get-FsField $rFields 'planCompletedAt')
                    $reviewStartedAt = Format-JstDate (Get-FsField $rFields 'reviewStartedAt')
                    $reviewCompletedAt = Format-JstDate (Get-FsField $rFields 'reviewCompletedAt')
                    $sessionDurationSeconds = Get-FsField $rFields 'sessionDurationSeconds'
                    $reviewAvailableAt = Format-JstDate (Get-FsField $rFields 'reviewAvailableAt')

                    $pRecordList += [PSCustomObject][ordered]@{
                        participantCode = $participantCode
                        uid = $uidVal
                        appVersion = $appVer
                        recordDate = $recordDate
                        lifeDayStart = $lifeDayStart
                        dailyIntentionText = $dailyIntentionText
                        dailyIntentionSource = $dailyIntentionSource
                        goalText = $goalText
                        predictedExcuse = $predictedExcuse
                        excuseSource = $excuseSource
                        firstStepText = $firstStepText
                        stepSource = $stepSource
                        outcomeStatus = $outcomeStatus
                        outcomeNormalized = $outcomeNormalized
                        predictionMatched = $predictionMatched
                        actualExcuse = $actualExcuse
                        actualExcuseSource = $actualExcuseSource
                        selfBlameScore = $selfBlameScore
                        createdAt = $createdAt
                        reviewedAt = $reviewedAt
                        sessionStartedAt = $sessionStartedAt
                        planStartedAt = $planStartedAt
                        planCompletedAt = $planCompletedAt
                        reviewStartedAt = $reviewStartedAt
                        reviewCompletedAt = $reviewCompletedAt
                        sessionDurationSeconds = $sessionDurationSeconds
                        reviewAvailableAt = $reviewAvailableAt
                        reusedNextLifeDay = ""
                    }
                }
            }
            $recPageToken = $recResp.nextPageToken
        } catch {
            Write-Host "Error fetching records for ${uid}: $_"
            $recPageToken = ""
        }
    } while ($recPageToken)

    foreach ($r in $pRecordList) {
        $r.reusedNextLifeDay = Test-ReusedNextLifeDay $r $pRecordList
        $recordRows += $r
    }
}

# Sort by createdAt descending
$recordRows = @($recordRows | Sort-Object { $_.createdAt } -Descending)

$csvLines = @()
$csvLines += ($recordHeaders -join ',')
foreach ($r in $recordRows) {
    $line = ($recordHeaders | ForEach-Object { Escape-CsvVal $r.$_ }) -join ','
    $csvLines += $line
}

$bom = [System.Text.Encoding]::UTF8.GetPreamble()
$recordsCsvContent = ($csvLines -join "`r`n")
$recordsBytes = [System.Text.Encoding]::UTF8.GetBytes($recordsCsvContent)
[System.IO.File]::WriteAllBytes("mindame_records.csv", $bom + $recordsBytes)
Write-Host "Exported $($recordRows.Count) records to mindame_records.csv"

# --- 2. Export publicPostsV4 & reactions ---
Write-Host "Fetching publicPostsV4..."
$postDocs = @()
$postPageToken = ""
do {
    $url = "$baseApi/publicPostsV4?pageSize=100"
    if ($postPageToken) { $url += "&pageToken=$postPageToken" }
    $resp = Invoke-RestMethod -Uri $url -Method Get -Headers $headers
    if ($resp.documents) { $postDocs += $resp.documents }
    $postPageToken = $resp.nextPageToken
} while ($postPageToken)

Write-Host "Found $($postDocs.Count) public posts."

$postHeaders = @(
    'postId',
    'ownerUid',
    'dailyIntentionText',
    'goalText',
    'excuseText',
    'firstStepText',
    'isVisible',
    'createdAt',
    'reactionUid',
    'reactionType',
    'reactionUpdatedAt'
)

$postRows = @()

foreach ($pDoc in $postDocs) {
    $postId = $pDoc.name.Split('/')[-1]
    $pFields = $pDoc.fields

    $reactDocs = @()
    $reactPageToken = ""
    do {
        $reactUrl = "https://firestore.googleapis.com/v1/$($pDoc.name)/reactions?pageSize=100"
        if ($reactPageToken) { $reactUrl += "&pageToken=$reactPageToken" }
        try {
            $reactResp = Invoke-RestMethod -Uri $reactUrl -Method Get -Headers $headers
            if ($reactResp.documents) { $reactDocs += $reactResp.documents }
            $reactPageToken = $reactResp.nextPageToken
        } catch {
            Write-Host "Error fetching reactions for ${postId}: $_"
            $reactPageToken = ""
        }
    } while ($reactPageToken)

    $dailyIntentionText = Get-FsField $pFields 'dailyIntentionText'
    if (-not $dailyIntentionText) { $dailyIntentionText = Get-FsField $pFields 'goalText' }
    $goalText = Get-FsField $pFields 'goalText'
    $excuseText = Get-FsField $pFields 'excuseText'
    $firstStepText = Get-FsField $pFields 'firstStepText'
    $isVisibleVal = Get-FsField $pFields 'isVisible'
    $isVisible = if ($isVisibleVal -ne "") { $isVisibleVal.ToLower() } else { "true" }
    $createdAt = Format-JstDate (Get-FsField $pFields 'createdAt')

    if ($reactDocs.Count -eq 0) {
        $postRows += [PSCustomObject][ordered]@{
            postId = $postId
            ownerUid = Get-FsField $pFields 'ownerUid'
            dailyIntentionText = $dailyIntentionText
            goalText = $goalText
            excuseText = $excuseText
            firstStepText = $firstStepText
            isVisible = $isVisible
            createdAt = $createdAt
            reactionUid = ''
            reactionType = ''
            reactionUpdatedAt = ''
        }
    } else {
        foreach ($rDoc in $reactDocs) {
            $rId = $rDoc.name.Split('/')[-1]
            $rFields = $rDoc.fields
            $updatedAt = Format-JstDate (Get-FsField $rFields 'updatedAt')
            if (-not $updatedAt) { $updatedAt = Format-JstDate (Get-FsField $rFields 'createdAt') }
            $postRows += [PSCustomObject][ordered]@{
                postId = $postId
                ownerUid = Get-FsField $pFields 'ownerUid'
                dailyIntentionText = $dailyIntentionText
                goalText = $goalText
                excuseText = $excuseText
                firstStepText = $firstStepText
                isVisible = $isVisible
                createdAt = $createdAt
                reactionUid = $rId
                reactionType = Get-FsField $rFields 'type'
                reactionUpdatedAt = $updatedAt
            }
        }
    }
}

$postRows = @($postRows | Sort-Object { $_.createdAt } -Descending)

$postCsvLines = @()
$postCsvLines += ($postHeaders -join ',')
foreach ($r in $postRows) {
    $line = ($postHeaders | ForEach-Object { Escape-CsvVal $r.$_ }) -join ','
    $postCsvLines += $line
}

$postsCsvContent = ($postCsvLines -join "`r`n")
$postsBytes = [System.Text.Encoding]::UTF8.GetBytes($postsCsvContent)
[System.IO.File]::WriteAllBytes("mindame_posts.csv", $bom + $postsBytes)
Write-Host "Exported $($postRows.Count) post/reaction rows to mindame_posts.csv"
Write-Host "All exports completed successfully!"
