use std::{io, time::Duration};

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

const RECORD_HEADER_BYTES: usize = 5;
const MAX_PLAINTEXT_BYTES: usize = 16 * 1024;
const CLIENT_HELLO_TIMEOUT: Duration = Duration::from_secs(10);

/// Keep CONNECT full-duplex, including protocols that send a server greeting first.
/// Only the initial plaintext ClientHello is reframed; TLS remains end-to-end.
pub(super) async fn copy_connect<C, U>(
    client: &mut C,
    upstream: &mut U,
    trailing: Vec<u8>,
) -> io::Result<()>
where
    C: AsyncRead + AsyncWrite + Unpin,
    U: AsyncRead + AsyncWrite + Unpin,
{
    let (client_read, mut client_write) = tokio::io::split(client);
    let (mut upstream_read, mut upstream_write) = tokio::io::split(upstream);
    let mut client_read = io::Cursor::new(trailing).chain(client_read);
    let upload = async {
        forward_initial_record(&mut client_read, &mut upstream_write, CLIENT_HELLO_TIMEOUT).await?;
        tokio::io::copy(&mut client_read, &mut upstream_write).await?;
        upstream_write.shutdown().await
    };
    let download = async {
        tokio::io::copy(&mut upstream_read, &mut client_write).await?;
        client_write.shutdown().await
    };
    tokio::try_join!(upload, download)?;
    Ok(())
}

async fn forward_initial_record<R, W>(
    reader: &mut R,
    writer: &mut W,
    timeout: Duration,
) -> io::Result<()>
where
    R: AsyncRead + Unpin,
    W: AsyncWrite + Unpin,
{
    let mut record = Vec::new();
    // Do not impose a handshake deadline on idle or server-first CONNECT protocols.
    read_prefix(reader, &mut record, 1).await?;
    if record.first() == Some(&22) {
        // On timeout or a partial record, forward every consumed byte unchanged.
        if let Ok(result) =
            tokio::time::timeout(timeout, read_client_hello(reader, &mut record)).await
        {
            result?;
        }
    }
    if let Some(split) = client_hello_split(&record) {
        // RFC 8446 section 5.1 permits handshake fragmentation across records.
        // A boundary inside server_name avoids single-record SNI middlebox resets.
        // No handshake/transcript bytes, hostnames, or authentication are changed.
        let mut header = [0; RECORD_HEADER_BYTES];
        header.copy_from_slice(&record[..RECORD_HEADER_BYTES]);
        header[3..].copy_from_slice(&((split - RECORD_HEADER_BYTES) as u16).to_be_bytes());
        writer.write_all(&header).await?;
        writer
            .write_all(&record[RECORD_HEADER_BYTES..split])
            .await?;
        header[3..].copy_from_slice(&((record.len() - split) as u16).to_be_bytes());
        writer.write_all(&header).await?;
        writer.write_all(&record[split..]).await?;
    } else {
        writer.write_all(&record).await?;
    }
    Ok(())
}

async fn read_client_hello<R: AsyncRead + Unpin>(
    reader: &mut R,
    record: &mut Vec<u8>,
) -> io::Result<()> {
    read_prefix(reader, record, 3).await?;
    if record.len() < 3 || record[1] != 3 || !(1..=3).contains(&record[2]) {
        return Ok(());
    }
    read_prefix(reader, record, RECORD_HEADER_BYTES).await?;
    if record.len() < RECORD_HEADER_BYTES {
        return Ok(());
    }
    let length = u16::from_be_bytes([record[3], record[4]]) as usize;
    if !(4..=MAX_PLAINTEXT_BYTES).contains(&length) {
        return Ok(());
    }
    read_prefix(reader, record, RECORD_HEADER_BYTES + 1).await?;
    if record.get(RECORD_HEADER_BYTES) != Some(&1) {
        return Ok(());
    }
    read_prefix(reader, record, RECORD_HEADER_BYTES + length).await
}

async fn read_prefix<R: AsyncRead + Unpin>(
    reader: &mut R,
    bytes: &mut Vec<u8>,
    length: usize,
) -> io::Result<()> {
    let mut buffer = [0; 4096];
    while bytes.len() < length {
        let remaining = (length - bytes.len()).min(buffer.len());
        let count = reader.read(&mut buffer[..remaining]).await?;
        if count == 0 {
            break;
        }
        bytes.extend_from_slice(&buffer[..count]);
    }
    Ok(())
}

fn take<'a>(bytes: &'a [u8], cursor: &mut usize, count: usize) -> Option<&'a [u8]> {
    let end = cursor.checked_add(count)?;
    let value = bytes.get(*cursor..end)?;
    *cursor = end;
    Some(value)
}

fn read_u16(bytes: &[u8], cursor: &mut usize) -> Option<usize> {
    let value = take(bytes, cursor, 2)?;
    Some(u16::from_be_bytes([value[0], value[1]]) as usize)
}

fn client_hello_split(record: &[u8]) -> Option<usize> {
    if record.len() < 9 || record[0] != 22 || record[1] != 3 || !(1..=3).contains(&record[2]) {
        return None;
    }
    let record_length = u16::from_be_bytes([record[3], record[4]]) as usize;
    let handshake_length = u32::from_be_bytes([0, record[6], record[7], record[8]]) as usize;
    if record_length > MAX_PLAINTEXT_BYTES
        || record_length + 5 != record.len()
        || record[5] != 1
        || handshake_length + 4 != record_length
    {
        return None;
    }
    let mut cursor = 9;
    take(record, &mut cursor, 2 + 32)?; // legacy_version and random
    let session_length = take(record, &mut cursor, 1)?[0] as usize;
    if session_length > 32 {
        return None;
    }
    take(record, &mut cursor, session_length)?;
    let cipher_length = read_u16(record, &mut cursor)?;
    if cipher_length == 0 || cipher_length % 2 != 0 {
        return None;
    }
    take(record, &mut cursor, cipher_length)?;
    let compression_length = take(record, &mut cursor, 1)?[0] as usize;
    if compression_length == 0 {
        return None;
    }
    take(record, &mut cursor, compression_length)?;
    let extensions_length = read_u16(record, &mut cursor)?;
    if cursor.checked_add(extensions_length)? != record.len() {
        return None;
    }
    let mut split = None;
    let mut seen_server_name = false;
    while cursor < record.len() {
        let kind = read_u16(record, &mut cursor)?;
        let length = read_u16(record, &mut cursor)?;
        let extension_start = cursor;
        let extension = take(record, &mut cursor, length)?;
        if kind != 0 {
            continue;
        }
        if seen_server_name {
            return None;
        }
        seen_server_name = true;
        let mut name_cursor = 0;
        let list_length = read_u16(extension, &mut name_cursor)?;
        if name_cursor.checked_add(list_length)? != extension.len() {
            return None;
        }
        let mut seen_host_name = false;
        while name_cursor < extension.len() {
            let name_type = take(extension, &mut name_cursor, 1)?[0];
            let name_length = read_u16(extension, &mut name_cursor)?;
            let name_start = name_cursor;
            take(extension, &mut name_cursor, name_length)?;
            if name_type == 0 {
                if seen_host_name || name_length == 0 {
                    return None;
                }
                seen_host_name = true;
                if name_length >= 2 {
                    split = Some(extension_start + name_start + name_length / 2);
                }
            }
        }
    }
    split
}

#[cfg(test)]
#[path = "tls_client_hello_tests.rs"]
mod tests;
