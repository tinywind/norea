use super::*;

fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

fn hello(host: Option<&[u8]>, padding: usize) -> Vec<u8> {
    let mut body = vec![3, 3];
    body.extend_from_slice(&[7; 32]);
    body.extend_from_slice(&[0, 0, 2, 0x13, 1, 1, 0]);
    let mut extensions = vec![0x0a, 0x0a, 0, 2, 1, 2]; // GREASE before SNI
    if let Some(host) = host {
        extensions.extend_from_slice(&[0, 0]);
        extensions.extend_from_slice(&((host.len() + 5) as u16).to_be_bytes());
        extensions.extend_from_slice(&((host.len() + 3) as u16).to_be_bytes());
        extensions.push(0);
        extensions.extend_from_slice(&(host.len() as u16).to_be_bytes());
        extensions.extend_from_slice(host);
    }
    extensions.extend_from_slice(&[0, 43, 0, 3, 2, 3, 4]); // supported_versions
    if padding > 0 {
        extensions.extend_from_slice(&[0, 21]);
        extensions.extend_from_slice(&(padding as u16).to_be_bytes());
        extensions.resize(extensions.len() + padding, 0);
    }
    body.extend_from_slice(&(extensions.len() as u16).to_be_bytes());
    body.extend_from_slice(&extensions);
    let mut record = vec![22, 3, 1];
    record.extend_from_slice(&((body.len() + 4) as u16).to_be_bytes());
    record.push(1);
    record.extend_from_slice(&(body.len() as u32).to_be_bytes()[1..]);
    record.extend_from_slice(&body);
    record
}

async fn forward(bytes: &[u8]) -> Vec<u8> {
    let mut input = bytes;
    let mut output = Vec::new();
    forward_initial_record(&mut input, &mut output, Duration::from_secs(1))
        .await
        .unwrap();
    tokio::io::copy(&mut input, &mut output).await.unwrap();
    output
}

fn assert_reframed(original: &[u8], output: &[u8]) {
    let boundary = client_hello_split(original).unwrap();
    let first_length = u16::from_be_bytes([output[3], output[4]]) as usize;
    assert_eq!(first_length, boundary - 5);
    let second = &output[5 + first_length..];
    let second_length = u16::from_be_bytes([second[3], second[4]]) as usize;
    assert_eq!(&output[..3], &original[..3]);
    assert_eq!(&second[..3], &original[..3]);
    assert!(first_length > 0 && second_length > 0);
    assert!(first_length <= MAX_PLAINTEXT_BYTES && second_length <= MAX_PLAINTEXT_BYTES);
    let payload = [&output[5..5 + first_length], &second[5..5 + second_length]].concat();
    assert_eq!(payload, original[5..]);
    assert_eq!(output.len(), original.len() + 5);
}

#[test]
fn locates_server_name_despite_other_extensions() {
    let record = hello(Some(b"source.example"), 128);
    let split = client_hello_split(&record).unwrap();
    assert_eq!(&record[split - 7..split + 7], b"source.example");
}

#[test]
fn preserves_handshake_transcript_for_tls_record_versions() {
    runtime().block_on(async {
        for version in [1, 2, 3] {
            let mut record = hello(Some(b"source.example"), 0);
            record[2] = version;
            assert_reframed(&record, &forward(&record).await);
        }
    });
}

#[test]
fn passes_through_client_hello_without_usable_server_name() {
    runtime().block_on(async {
        for host in [None, Some(b"x".as_slice()), Some(b"".as_slice())] {
            let bytes = hello(host, 0);
            assert!(client_hello_split(&bytes).is_none());
            assert_eq!(forward(&bytes).await, bytes);
        }
    });
}

#[test]
fn every_truncated_prefix_is_forwarded_without_loss() {
    runtime().block_on(async {
        let bytes = hello(Some(b"source.example"), 0);
        for end in 0..bytes.len() {
            let prefix = &bytes[..end];
            assert!(client_hello_split(prefix).is_none(), "prefix length {end}");
            assert_eq!(forward(prefix).await, prefix);
        }
    });
}

#[test]
fn malformed_lengths_and_non_client_hellos_are_unchanged() {
    runtime().block_on(async {
        let original = hello(Some(b"source.example"), 0);
        for (index, value) in [
            (0, 23),
            (1, 2),
            (2, 9),
            (3, 255),
            (5, 2),
            (6, 255),
            (43, 255),
            (44, 255),
            (48, 0),
            (50, 255),
        ] {
            let mut bytes = original.clone();
            bytes[index] = value;
            assert!(client_hello_split(&bytes).is_none(), "index {index}");
            assert_eq!(forward(&bytes).await, bytes);
        }
    });
}

#[test]
fn parser_is_bounded_under_byte_mutations() {
    let original = hello(Some(b"source.example"), 96);
    for index in 0..original.len() {
        for value in [0, 1, 128, 255] {
            let mut bytes = original.clone();
            bytes[index] = value;
            if let Some(split) = client_hello_split(&bytes) {
                assert!(split > 5 && split < bytes.len());
            }
        }
    }
}

#[test]
fn fragmented_handshake_and_application_records_are_unchanged() {
    runtime().block_on(async {
        let mut bytes = hello(Some(b"source.example"), 0);
        let length = bytes.len();
        bytes[4] = (length - 6) as u8;
        bytes.truncate(length - 1);
        assert!(client_hello_split(&bytes).is_none());
        assert_eq!(forward(&bytes).await, bytes);
        let app = [23, 3, 3, 0, 4, 1, 2, 3, 4];
        assert_eq!(forward(&app).await, app);
    });
}

#[test]
fn later_records_and_pipelined_bytes_remain_untouched() {
    runtime().block_on(async {
        let record = hello(Some(b"source.example"), 0);
        let tail = [20, 3, 3, 0, 1, 1, 23, 3, 3, 0, 3, 9, 8, 7];
        let bytes = [record.as_slice(), &tail].concat();
        let output = forward(&bytes).await;
        assert_reframed(&record, &output[..record.len() + 5]);
        assert_eq!(&output[record.len() + 5..], &tail);
    });
}

#[test]
fn accepts_a_large_client_hello_without_changing_its_payload() {
    runtime().block_on(async {
        let bytes = hello(Some(b"source.example"), 15_000);
        assert_reframed(&bytes, &forward(&bytes).await);
    });
}

#[test]
fn partial_header_timeout_preserves_consumed_bytes() {
    runtime().block_on(async {
        let (mut client, mut reader) = tokio::io::duplex(64);
        client.write_all(&[22, 3, 1]).await.unwrap();
        let mut output = Vec::new();
        forward_initial_record(&mut reader, &mut output, Duration::from_millis(5))
            .await
            .unwrap();
        assert_eq!(output, [22, 3, 1]);
    });
}

#[test]
fn single_byte_reads_and_connect_trailing_bytes_preserve_both_directions() {
    runtime().block_on(async {
        let bytes = hello(Some(b"source.example"), 128);
        let expected = bytes.clone();
        let trailing = bytes[..3].to_vec();
        let (mut client, mut proxy_client) = tokio::io::duplex(1);
        let (mut server, mut proxy_server) = tokio::io::duplex(1);
        let proxy = tokio::spawn(async move {
            copy_connect(&mut proxy_client, &mut proxy_server, trailing)
                .await
                .unwrap()
        });
        let origin = tokio::spawn(async move {
            let mut input = Vec::new();
            server.read_to_end(&mut input).await.unwrap();
            assert_reframed(&expected, &input);
            server
                .write_all(b"server response after client EOF")
                .await
                .unwrap();
            server.shutdown().await.unwrap();
        });
        client.write_all(&bytes[3..]).await.unwrap();
        client.shutdown().await.unwrap();
        let mut response = Vec::new();
        client.read_to_end(&mut response).await.unwrap();
        assert_eq!(response, b"server response after client EOF");
        origin.await.unwrap();
        proxy.await.unwrap();
    });
}

#[test]
fn server_first_non_tls_protocol_remains_full_duplex() {
    runtime().block_on(async {
        let (mut client, mut proxy_client) = tokio::io::duplex(64);
        let (mut server, mut proxy_server) = tokio::io::duplex(64);
        let proxy = tokio::spawn(async move {
            copy_connect(&mut proxy_client, &mut proxy_server, Vec::new())
                .await
                .unwrap()
        });
        server.write_all(b"ready").await.unwrap();
        let mut greeting = [0; 5];
        tokio::time::timeout(Duration::from_secs(1), client.read_exact(&mut greeting))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(&greeting, b"ready");
        client.write_all(b"ping").await.unwrap();
        client.shutdown().await.unwrap();
        let mut request = Vec::new();
        server.read_to_end(&mut request).await.unwrap();
        assert_eq!(request, b"ping");
        server.shutdown().await.unwrap();
        let mut tail = Vec::new();
        client.read_to_end(&mut tail).await.unwrap();
        proxy.await.unwrap();
    });
}
