use std::ffi::c_void;
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::ptr;
use std::slice;

use aes::{Aes128, Aes192, Aes256};
use aes_gcm::aead::{AeadInPlace, KeyInit as AeadKeyInit};
use aes_gcm::{Aes128Gcm, Aes256Gcm, AesGcm, Nonce as AesNonce};
use blowfish::Blowfish;
use cbc::cipher::block_padding::Pkcs7;
use cbc::cipher::{
    BlockDecryptMut, BlockEncryptMut, KeyIvInit, StreamCipher, generic_array::typenum::U12,
};
use chacha20poly1305::{ChaCha20Poly1305, Nonce as ChaChaNonce};
use ctr::Ctr128BE;
use des::{Des, TdesEde3};
use digest::Digest;
use hmac::{Hmac, Mac};
use md4::Md4;
use md5::Md5;
use sha1::Sha1;
use sha2::{Sha224, Sha256, Sha384, Sha512};

const AES_128_CBC: u32 = 1;
const AES_192_CBC: u32 = 2;
const AES_256_CBC: u32 = 3;
const DES_CBC: u32 = 4;
const DES_EDE3_CBC: u32 = 5;
const BF_CBC: u32 = 6;
const AES_256_CTR: u32 = 7;
const AES_128_GCM: u32 = 8;
const AES_192_GCM: u32 = 9;
const AES_256_GCM: u32 = 10;
const CHACHA20_POLY1305: u32 = 11;
const MD4: u32 = 12;
const MD5: u32 = 13;
const SHA1: u32 = 14;
const SHA224: u32 = 15;
const SHA256: u32 = 16;
const SHA384: u32 = 17;
const SHA512: u32 = 18;

struct DigestHandle {
    algorithm: u32,
    data: Vec<u8>,
}

struct HmacHandle {
    algorithm: u32,
    key: Vec<u8>,
    data: Vec<u8>,
}

struct CipherHandle {
    algorithm: u32,
    key: Vec<u8>,
    iv: Vec<u8>,
    data: Vec<u8>,
    encrypt: bool,
}

struct AeadHandle {
    algorithm: u32,
    key: Vec<u8>,
    encrypt: bool,
}

pub(super) unsafe extern "C" fn random(output: *mut u8, output_len: usize) -> i32 {
    ffi_status(|| {
        let output = output_slice(output, output_len)?;
        getrandom::fill(output).map_err(|error| error.to_string())
    })
}

pub(super) unsafe extern "C" fn digest_new(algorithm: u32) -> *mut c_void {
    ffi_pointer(|| {
        digest_size_for(algorithm)?;
        Ok(DigestHandle {
            algorithm,
            data: Vec::new(),
        })
    })
}

pub(super) unsafe extern "C" fn digest_free(handle: *mut c_void) {
    free_handle::<DigestHandle>(handle);
}

pub(super) unsafe extern "C" fn digest_update(
    handle: *mut c_void,
    input: *const u8,
    input_len: usize,
) -> i32 {
    ffi_status(|| {
        let handle = handle_mut::<DigestHandle>(handle)?;
        handle
            .data
            .extend_from_slice(input_slice(input, input_len)?);
        Ok(())
    })
}

pub(super) unsafe extern "C" fn digest_final(
    handle: *mut c_void,
    output: *mut u8,
    output_capacity: usize,
) -> usize {
    ffi_length(|| {
        let handle = handle_mut::<DigestHandle>(handle)?;
        let digest = compute_digest(handle.algorithm, &handle.data)?;
        copy_output(output, output_capacity, &digest)
    })
}

pub(super) unsafe extern "C" fn digest_size(handle: *const c_void) -> usize {
    ffi_length(|| {
        let handle = handle_ref::<DigestHandle>(handle)?;
        digest_size_for(handle.algorithm)
    })
}

pub(super) unsafe extern "C" fn hmac_new(
    algorithm: u32,
    key: *const u8,
    key_len: usize,
) -> *mut c_void {
    ffi_pointer(|| {
        digest_size_for(algorithm)?;
        Ok(HmacHandle {
            algorithm,
            key: input_slice(key, key_len)?.to_vec(),
            data: Vec::new(),
        })
    })
}

pub(super) unsafe extern "C" fn hmac_free(handle: *mut c_void) {
    free_handle::<HmacHandle>(handle);
}

pub(super) unsafe extern "C" fn hmac_reset(handle: *mut c_void) -> i32 {
    ffi_status(|| {
        handle_mut::<HmacHandle>(handle)?.data.clear();
        Ok(())
    })
}

pub(super) unsafe extern "C" fn hmac_update(
    handle: *mut c_void,
    input: *const u8,
    input_len: usize,
) -> i32 {
    ffi_status(|| {
        let handle = handle_mut::<HmacHandle>(handle)?;
        handle
            .data
            .extend_from_slice(input_slice(input, input_len)?);
        Ok(())
    })
}

pub(super) unsafe extern "C" fn hmac_final(
    handle: *mut c_void,
    output: *mut u8,
    output_capacity: usize,
) -> usize {
    ffi_length(|| {
        let handle = handle_mut::<HmacHandle>(handle)?;
        let digest = compute_hmac(handle.algorithm, &handle.key, &handle.data)?;
        copy_output(output, output_capacity, &digest)
    })
}

pub(super) unsafe extern "C" fn hmac_size(handle: *const c_void) -> usize {
    ffi_length(|| {
        let handle = handle_ref::<HmacHandle>(handle)?;
        digest_size_for(handle.algorithm)
    })
}

pub(super) unsafe extern "C" fn cipher_new(
    algorithm: u32,
    key: *const u8,
    key_len: usize,
    encrypt: i32,
) -> *mut c_void {
    ffi_pointer(|| {
        if !is_cipher_supported(algorithm) {
            return Err("unsupported cipher".to_owned());
        }
        let expected = cipher_key_size(algorithm)?;
        let key = input_slice(key, key_len)?;
        if key.len() < expected {
            return Err("insufficient cipher key".to_owned());
        }
        Ok(CipherHandle {
            algorithm,
            key: key[..expected].to_vec(),
            iv: Vec::new(),
            data: Vec::new(),
            encrypt: encrypt != 0,
        })
    })
}

pub(super) unsafe extern "C" fn cipher_free(handle: *mut c_void) {
    free_handle::<CipherHandle>(handle);
}

pub(super) unsafe extern "C" fn cipher_reset(
    handle: *mut c_void,
    iv: *const u8,
    iv_len: usize,
) -> i32 {
    ffi_status(|| {
        let handle = handle_mut::<CipherHandle>(handle)?;
        let expected = cipher_iv_size(handle.algorithm)?;
        let iv = input_slice(iv, iv_len)?;
        if iv.len() < expected {
            return Err("insufficient cipher IV".to_owned());
        }
        handle.iv.clear();
        handle.iv.extend_from_slice(&iv[..expected]);
        handle.data.clear();
        Ok(())
    })
}

pub(super) unsafe extern "C" fn cipher_update(
    handle: *mut c_void,
    input: *const u8,
    input_len: usize,
) -> i32 {
    ffi_status(|| {
        let handle = handle_mut::<CipherHandle>(handle)?;
        handle
            .data
            .extend_from_slice(input_slice(input, input_len)?);
        Ok(())
    })
}

pub(super) unsafe extern "C" fn cipher_final(
    handle: *mut c_void,
    output: *mut u8,
    output_capacity: usize,
) -> usize {
    ffi_length(|| {
        let handle = handle_mut::<CipherHandle>(handle)?;
        let result = crypt_cipher(handle)?;
        copy_output(output, output_capacity, &result)
    })
}

pub(super) unsafe extern "C" fn cipher_supported(algorithm: u32) -> i32 {
    i32::from(is_cipher_supported(algorithm))
}

pub(super) unsafe extern "C" fn aead_new(
    algorithm: u32,
    key: *const u8,
    key_len: usize,
    encrypt: i32,
) -> *mut c_void {
    ffi_pointer(|| {
        if !is_aead_supported(algorithm) {
            return Err("unsupported AEAD cipher".to_owned());
        }
        let expected = cipher_key_size(algorithm)?;
        let key = input_slice(key, key_len)?;
        if key.len() < expected {
            return Err("insufficient AEAD key".to_owned());
        }
        Ok(AeadHandle {
            algorithm,
            key: key[..expected].to_vec(),
            encrypt: encrypt != 0,
        })
    })
}

pub(super) unsafe extern "C" fn aead_free(handle: *mut c_void) {
    free_handle::<AeadHandle>(handle);
}

pub(super) unsafe extern "C" fn aead_encrypt(
    handle: *mut c_void,
    input: *const u8,
    input_len: usize,
    output: *mut u8,
    output_capacity: usize,
    nonce: *const u8,
    nonce_len: usize,
    tag: *mut u8,
    tag_len: usize,
    additional_data: *const u8,
    additional_data_len: usize,
) -> i32 {
    ffi_status(|| {
        let handle = handle_mut::<AeadHandle>(handle)?;
        if !handle.encrypt || output_capacity < input_len || tag_len < 16 {
            return Err("invalid AEAD encryption buffers".to_owned());
        }
        let input = input_slice(input, input_len)?;
        let output = output_slice(output, output_capacity)?;
        output[..input_len].copy_from_slice(input);
        let nonce = input_slice(nonce, nonce_len)?;
        let additional_data = input_slice(additional_data, additional_data_len)?;
        let auth_tag = encrypt_aead(handle, &mut output[..input_len], nonce, additional_data)?;
        output_slice(tag, tag_len)?[..16].copy_from_slice(&auth_tag);
        Ok(())
    })
}

pub(super) unsafe extern "C" fn aead_decrypt(
    handle: *mut c_void,
    input: *const u8,
    input_len: usize,
    output: *mut u8,
    output_capacity: usize,
    nonce: *const u8,
    nonce_len: usize,
    tag: *mut u8,
    tag_len: usize,
    additional_data: *const u8,
    additional_data_len: usize,
) -> i32 {
    ffi_status(|| {
        let handle = handle_mut::<AeadHandle>(handle)?;
        if handle.encrypt || output_capacity < input_len || tag_len < 16 {
            return Err("invalid AEAD decryption buffers".to_owned());
        }
        let input = input_slice(input, input_len)?;
        let output = output_slice(output, output_capacity)?;
        output[..input_len].copy_from_slice(input);
        let nonce = input_slice(nonce, nonce_len)?;
        let tag = input_slice(tag, tag_len)?;
        let additional_data = input_slice(additional_data, additional_data_len)?;
        decrypt_aead(
            handle,
            &mut output[..input_len],
            nonce,
            &tag[..16],
            additional_data,
        )
    })
}

pub(super) unsafe extern "C" fn aead_supported(algorithm: u32) -> i32 {
    i32::from(is_aead_supported(algorithm))
}

fn compute_digest(algorithm: u32, data: &[u8]) -> Result<Vec<u8>, String> {
    macro_rules! digest {
        ($type:ty) => {
            Ok(<$type as Digest>::digest(data).to_vec())
        };
    }
    match algorithm {
        MD4 => digest!(Md4),
        MD5 => digest!(Md5),
        SHA1 => digest!(Sha1),
        SHA224 => digest!(Sha224),
        SHA256 => digest!(Sha256),
        SHA384 => digest!(Sha384),
        SHA512 => digest!(Sha512),
        _ => Err("unsupported digest".to_owned()),
    }
}

fn compute_hmac(algorithm: u32, key: &[u8], data: &[u8]) -> Result<Vec<u8>, String> {
    macro_rules! hmac {
        ($type:ty) => {{
            let mut mac =
                <Hmac<$type> as Mac>::new_from_slice(key).map_err(|error| error.to_string())?;
            mac.update(data);
            Ok(mac.finalize().into_bytes().to_vec())
        }};
    }
    match algorithm {
        MD4 => hmac!(Md4),
        MD5 => hmac!(Md5),
        SHA1 => hmac!(Sha1),
        SHA224 => hmac!(Sha224),
        SHA256 => hmac!(Sha256),
        SHA384 => hmac!(Sha384),
        SHA512 => hmac!(Sha512),
        _ => Err("unsupported HMAC".to_owned()),
    }
}

fn crypt_cipher(handle: &CipherHandle) -> Result<Vec<u8>, String> {
    macro_rules! cbc {
        ($type:ty) => {
            if handle.encrypt {
                cbc::Encryptor::<$type>::new_from_slices(&handle.key, &handle.iv)
                    .map_err(|error| error.to_string())?
                    .encrypt_padded_vec_mut::<Pkcs7>(&handle.data)
            } else {
                cbc::Decryptor::<$type>::new_from_slices(&handle.key, &handle.iv)
                    .map_err(|error| error.to_string())?
                    .decrypt_padded_vec_mut::<Pkcs7>(&handle.data)
                    .map_err(|error| error.to_string())?
            }
        };
    }
    let output = match handle.algorithm {
        AES_128_CBC => cbc!(Aes128),
        AES_192_CBC => cbc!(Aes192),
        AES_256_CBC => cbc!(Aes256),
        DES_CBC => cbc!(Des),
        DES_EDE3_CBC => cbc!(TdesEde3),
        BF_CBC => cbc!(Blowfish),
        AES_256_CTR => {
            let mut output = handle.data.clone();
            Ctr128BE::<Aes256>::new_from_slices(&handle.key, &handle.iv)
                .map_err(|error| error.to_string())?
                .apply_keystream(&mut output);
            output
        }
        _ => return Err("unsupported cipher".to_owned()),
    };
    Ok(output)
}

type Aes192Gcm = AesGcm<Aes192, U12>;

fn encrypt_aead(
    handle: &AeadHandle,
    buffer: &mut [u8],
    nonce: &[u8],
    additional_data: &[u8],
) -> Result<Vec<u8>, String> {
    macro_rules! encrypt {
        ($type:ty, $nonce:ty) => {
            <$type>::new_from_slice(&handle.key)
                .map_err(|error| error.to_string())?
                .encrypt_in_place_detached(<$nonce>::from_slice(nonce), additional_data, buffer)
                .map(|tag| tag.to_vec())
                .map_err(|error| error.to_string())
        };
    }
    match handle.algorithm {
        AES_128_GCM => encrypt!(Aes128Gcm, AesNonce<U12>),
        AES_192_GCM => encrypt!(Aes192Gcm, AesNonce<U12>),
        AES_256_GCM => encrypt!(Aes256Gcm, AesNonce<U12>),
        CHACHA20_POLY1305 => encrypt!(ChaCha20Poly1305, ChaChaNonce),
        _ => Err("unsupported AEAD cipher".to_owned()),
    }
}

fn decrypt_aead(
    handle: &AeadHandle,
    buffer: &mut [u8],
    nonce: &[u8],
    tag: &[u8],
    additional_data: &[u8],
) -> Result<(), String> {
    macro_rules! decrypt {
        ($type:ty, $nonce:ty) => {
            <$type>::new_from_slice(&handle.key)
                .map_err(|error| error.to_string())?
                .decrypt_in_place_detached(
                    <$nonce>::from_slice(nonce),
                    additional_data,
                    buffer,
                    tag.into(),
                )
                .map_err(|error| error.to_string())
        };
    }
    match handle.algorithm {
        AES_128_GCM => decrypt!(Aes128Gcm, AesNonce<U12>),
        AES_192_GCM => decrypt!(Aes192Gcm, AesNonce<U12>),
        AES_256_GCM => decrypt!(Aes256Gcm, AesNonce<U12>),
        CHACHA20_POLY1305 => decrypt!(ChaCha20Poly1305, ChaChaNonce),
        _ => Err("unsupported AEAD cipher".to_owned()),
    }
}

const fn is_cipher_supported(algorithm: u32) -> bool {
    matches!(
        algorithm,
        AES_128_CBC | AES_192_CBC | AES_256_CBC | DES_CBC | DES_EDE3_CBC | BF_CBC | AES_256_CTR
    )
}

const fn is_aead_supported(algorithm: u32) -> bool {
    matches!(
        algorithm,
        AES_128_GCM | AES_192_GCM | AES_256_GCM | CHACHA20_POLY1305
    )
}

const fn cipher_key_size(algorithm: u32) -> Result<usize, String> {
    match algorithm {
        AES_128_CBC | AES_128_GCM | BF_CBC => Ok(16),
        AES_192_CBC | AES_192_GCM | DES_EDE3_CBC => Ok(24),
        AES_256_CBC | AES_256_CTR | AES_256_GCM | CHACHA20_POLY1305 => Ok(32),
        DES_CBC => Ok(8),
        _ => Err(String::new()),
    }
}

const fn cipher_iv_size(algorithm: u32) -> Result<usize, String> {
    match algorithm {
        AES_128_CBC | AES_192_CBC | AES_256_CBC | AES_256_CTR => Ok(16),
        DES_CBC | DES_EDE3_CBC | BF_CBC => Ok(8),
        AES_128_GCM | AES_192_GCM | AES_256_GCM | CHACHA20_POLY1305 => Ok(12),
        _ => Err(String::new()),
    }
}

const fn digest_size_for(algorithm: u32) -> Result<usize, String> {
    match algorithm {
        MD4 | MD5 => Ok(16),
        SHA1 => Ok(20),
        SHA224 => Ok(28),
        SHA256 => Ok(32),
        SHA384 => Ok(48),
        SHA512 => Ok(64),
        _ => Err(String::new()),
    }
}

fn ffi_status(operation: impl FnOnce() -> Result<(), String>) -> i32 {
    i32::from(matches!(
        catch_unwind(AssertUnwindSafe(operation)),
        Ok(Ok(()))
    ))
}

fn ffi_length(operation: impl FnOnce() -> Result<usize, String>) -> usize {
    catch_unwind(AssertUnwindSafe(operation))
        .ok()
        .and_then(Result::ok)
        .unwrap_or(0)
}

fn ffi_pointer<T>(operation: impl FnOnce() -> Result<T, String>) -> *mut c_void {
    catch_unwind(AssertUnwindSafe(operation))
        .ok()
        .and_then(Result::ok)
        .map_or(ptr::null_mut(), |handle| {
            Box::into_raw(Box::new(handle)).cast()
        })
}

fn input_slice<'a>(input: *const u8, len: usize) -> Result<&'a [u8], String> {
    if len == 0 {
        return Ok(&[]);
    }
    if input.is_null() {
        return Err("null input".to_owned());
    }
    // SAFETY: callers lend `len` readable bytes for the callback.
    Ok(unsafe { slice::from_raw_parts(input.cast(), len) })
}

fn output_slice<'a>(output: *mut u8, len: usize) -> Result<&'a mut [u8], String> {
    if len == 0 {
        return Ok(&mut []);
    }
    if output.is_null() {
        return Err("null output".to_owned());
    }
    // SAFETY: callers lend `len` writable bytes for the callback.
    Ok(unsafe { slice::from_raw_parts_mut(output.cast(), len) })
}

fn copy_output(output: *mut u8, capacity: usize, value: &[u8]) -> Result<usize, String> {
    if value.len() > capacity {
        return Err("output buffer is too small".to_owned());
    }
    output_slice(output, capacity)?[..value.len()].copy_from_slice(value);
    Ok(value.len())
}

fn handle_mut<'a, T>(handle: *mut c_void) -> Result<&'a mut T, String> {
    // SAFETY: handles are created and typed by the matching constructor.
    unsafe { handle.cast::<T>().as_mut() }.ok_or_else(|| "null handle".to_owned())
}

fn handle_ref<'a, T>(handle: *const c_void) -> Result<&'a T, String> {
    // SAFETY: handles are created and typed by the matching constructor.
    unsafe { handle.cast::<T>().as_ref() }.ok_or_else(|| "null handle".to_owned())
}

fn free_handle<T>(handle: *mut c_void) {
    if !handle.is_null() {
        // SAFETY: the pointer came from `Box<T>` and is released exactly once.
        unsafe { drop(Box::from_raw(handle.cast::<T>())) };
    }
}

#[cfg(test)]
mod tests {
    use std::fmt::Write as _;
    use std::ptr;

    use super::{
        AES_128_CBC, AES_128_GCM, AES_192_CBC, AES_192_GCM, AES_256_CBC, AES_256_CTR, AES_256_GCM,
        AeadHandle, BF_CBC, CHACHA20_POLY1305, CipherHandle, DES_CBC, DES_EDE3_CBC, MD4, MD5, SHA1,
        SHA224, SHA256, SHA384, SHA512, cipher_iv_size, cipher_key_size, compute_digest,
        compute_hmac, crypt_cipher, decrypt_aead, digest_size_for, encrypt_aead, input_slice,
        output_slice,
    };

    #[test]
    fn every_aead_cipher_round_trips_and_rejects_a_modified_tag() {
        let nonce = [9; 12];
        let additional_data = b"openvpn-header";
        for algorithm in [AES_128_GCM, AES_192_GCM, AES_256_GCM, CHACHA20_POLY1305] {
            let key = (0..cipher_key_size(algorithm).unwrap())
                .map(|value| u8::try_from(value).unwrap())
                .collect::<Vec<_>>();
            let mut encrypted = b"encrypted tunnel packet".to_vec();
            let encryptor = AeadHandle {
                algorithm,
                key: key.clone(),
                encrypt: true,
            };
            let tag = encrypt_aead(&encryptor, &mut encrypted, &nonce, additional_data).unwrap();
            let decryptor = AeadHandle {
                algorithm,
                key,
                encrypt: false,
            };
            let mut decrypted = encrypted.clone();
            decrypt_aead(&decryptor, &mut decrypted, &nonce, &tag, additional_data).unwrap();
            assert_eq!(decrypted, b"encrypted tunnel packet");

            let mut bad_tag = tag;
            bad_tag[0] ^= 1;
            assert!(
                decrypt_aead(
                    &decryptor,
                    &mut encrypted,
                    &nonce,
                    &bad_tag,
                    additional_data
                )
                .is_err()
            );
        }
    }

    #[test]
    fn every_classic_cipher_round_trips() {
        for algorithm in [
            AES_128_CBC,
            AES_192_CBC,
            AES_256_CBC,
            DES_CBC,
            DES_EDE3_CBC,
            BF_CBC,
            AES_256_CTR,
        ] {
            let key = (0..cipher_key_size(algorithm).unwrap())
                .map(|value| u8::try_from(value + 1).unwrap())
                .collect::<Vec<_>>();
            let iv = (0..cipher_iv_size(algorithm).unwrap())
                .map(|value| u8::try_from(value + 17).unwrap())
                .collect::<Vec<_>>();
            let plaintext = b"all OpenVPN classic cipher families";
            let encrypted = crypt_cipher(&CipherHandle {
                algorithm,
                key: key.clone(),
                iv: iv.clone(),
                data: plaintext.to_vec(),
                encrypt: true,
            })
            .unwrap();
            let decrypted = crypt_cipher(&CipherHandle {
                algorithm,
                key,
                iv,
                data: encrypted,
                encrypt: false,
            })
            .unwrap();
            assert_eq!(decrypted, plaintext, "algorithm {algorithm}");
        }
    }

    #[test]
    fn every_digest_matches_its_standard_abc_vector() {
        let vectors = [
            (MD4, "a448017aaf21d8525fc10ae87aa6729d"),
            (MD5, "900150983cd24fb0d6963f7d28e17f72"),
            (SHA1, "a9993e364706816aba3e25717850c26c9cd0d89d"),
            (
                SHA224,
                "23097d223405d8228642a477bda255b32aadbce4bda0b3f7e36c9da7",
            ),
            (
                SHA256,
                "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            ),
            (
                SHA384,
                "cb00753f45a35e8bb5a03d699ac65007272c32ab0eded1631a8b605a43ff5bed8086072ba1e7cc2358baeca134c825a7",
            ),
            (
                SHA512,
                "ddaf35a193617abacc417349ae20413112e6fa4e89a97ea20a9eeee64b55d39a2192992a274fc1a836ba3c23a3feebbd454d4423643ce80e2a9ac94fa54ca49f",
            ),
        ];
        for (algorithm, expected) in vectors {
            let digest = compute_digest(algorithm, b"abc").unwrap();
            assert_eq!(digest.len(), digest_size_for(algorithm).unwrap());
            assert_eq!(to_hex(&digest), expected);
            assert_eq!(
                compute_hmac(algorithm, b"key", b"abc").unwrap().len(),
                digest.len()
            );
        }
    }

    #[test]
    fn zero_length_ffi_buffers_accept_null_pointers() {
        assert!(input_slice(ptr::null(), 0).unwrap().is_empty());
        assert!(output_slice(ptr::null_mut(), 0).unwrap().is_empty());
        assert!(input_slice(ptr::null(), 1).is_err());
        assert!(output_slice(ptr::null_mut(), 1).is_err());
    }

    fn to_hex(value: &[u8]) -> String {
        value.iter().fold(String::new(), |mut output, byte| {
            write!(output, "{byte:02x}").unwrap();
            output
        })
    }
}
