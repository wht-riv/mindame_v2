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

function Escape-CsvVal($val) {
    if ($null -eq $val) { return '""' }
    $s = [string]$val
    if ($s.Contains(',') -or $s.Contains('"') -or $s.Contains("`n") -or $s.Contains("`r")) {
        return '"' + $s.Replace('"', '""') + '"'
    }
    return '"' + $s + '"'
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
    'lifeDayStart',
    'predictedExcuse',
    'excuseSource',
    'firstStepText',
    'stepSource',
    'outcomeStatus',
    'predictionMatched',
    'actualExcuse',
    'selfBlameScore',
    'createdAt',
    'reviewedAt',
    'sessionStartedAt',
    'planStartedAt',
    'planCompletedAt',
    'reviewStartedAt',
    'reviewCompletedAt'
)

$recordRows = @()

foreach ($pDoc in $partDocs) {
    $uid = $pDoc.name.Split('/')[-1]
    $pFields = $pDoc.fields
    $pCode = Get-FsField $pFields 'participantCode'
    $pVer = Get-FsField $pFields 'appVersion'

    # Fetch records subcollection
    $recPageToken = ""
    do {
        $recUrl = "https://firestore.googleapis.com/v1/$($pDoc.name)/records?pageSize=100"
        if ($recPageToken) { $recUrl += "&pageToken=$recPageToken" }
        try {
            $recResp = Invoke-RestMethod -Uri $recUrl -Method Get -Headers $headers
            if ($recResp.documents) {
                foreach ($rDoc in $recResp.documents) {
                    $rFields = $rDoc.fields
                    $row = [ordered]@{
                        participantCode = $(if ($v = Get-FsField $rFields 'participantCode') { $v } else { $pCode })
                        uid = $(if ($v = Get-FsField $rFields 'ownerUid') { $v } else { $uid })
                        appVersion = $(if ($v = Get-FsField $rFields 'appVersion') { $v } else { $pVer })
                        lifeDayStart = $(if ($v = Get-FsField $rFields 'lifeDayStart') { $v } elseif ($v = Get-FsField $rFields 'recordDate') { $v } else { "" })
                        predictedExcuse = Get-FsField $rFields 'predictedExcuse'
                        excuseSource = Get-FsField $rFields 'excuseSource'
                        firstStepText = Get-FsField $rFields 'firstStepText'
                        stepSource = Get-FsField $rFields 'stepSource'
                        outcomeStatus = Get-FsField $rFields 'outcomeStatus'
                        predictionMatched = Get-FsField $rFields 'predictionMatched'
                        actualExcuse = Get-FsField $rFields 'actualExcuse'
                        selfBlameScore = Get-FsField $rFields 'selfBlameScore'
                        createdAt = Get-FsField $rFields 'createdAt'
                        reviewedAt = Get-FsField $rFields 'reviewedAt'
                        sessionStartedAt = Format-JstDate (Get-FsField $rFields 'sessionStartedAt')
                        planStartedAt = Format-JstDate (Get-FsField $rFields 'planStartedAt')
                        planCompletedAt = Get-FsField $rFields 'planCompletedAt'
                        reviewStartedAt = Format-JstDate (Get-FsField $rFields 'reviewStartedAt')
                        reviewCompletedAt = Get-FsField $rFields 'reviewCompletedAt'
                    }
                    $recordRows += [PSCustomObject]$row
                }
            }
            $recPageToken = $recResp.nextPageToken
        } catch {
            Write-Host "Error fetching records for ${uid}: $_"
            $recPageToken = ""
        }
    } while ($recPageToken)
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

    if ($reactDocs.Count -eq 0) {
        $postRows += [PSCustomObject][ordered]@{
            postId = $postId
            ownerUid = Get-FsField $pFields 'ownerUid'
            goalText = Get-FsField $pFields 'goalText'
            excuseText = Get-FsField $pFields 'excuseText'
            firstStepText = Get-FsField $pFields 'firstStepText'
            isVisible = Get-FsField $pFields 'isVisible'
            createdAt = Get-FsField $pFields 'createdAt'
            reactionUid = ''
            reactionType = ''
            reactionUpdatedAt = ''
        }
    } else {
        foreach ($rDoc in $reactDocs) {
            $rId = $rDoc.name.Split('/')[-1]
            $rFields = $rDoc.fields
            $updatedAt = Get-FsField $rFields 'updatedAt'
            if (-not $updatedAt) { $updatedAt = Get-FsField $rFields 'createdAt' }
            $postRows += [PSCustomObject][ordered]@{
                postId = $postId
                ownerUid = Get-FsField $pFields 'ownerUid'
                goalText = Get-FsField $pFields 'goalText'
                excuseText = Get-FsField $pFields 'excuseText'
                firstStepText = Get-FsField $pFields 'firstStepText'
                isVisible = Get-FsField $pFields 'isVisible'
                createdAt = Get-FsField $pFields 'createdAt'
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
