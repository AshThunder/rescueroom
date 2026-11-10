//! Minimal EIP-1559 (type 2) transaction encoding for plain ETH transfers.
//! Kept dependency-free so the vault can build the exact payload the MPC signer signs.

pub fn rlp_bytes(b: &[u8]) -> Vec<u8> {
    if b.len() == 1 && b[0] < 0x80 {
        return b.to_vec();
    }
    let mut out = rlp_len_prefix(b.len(), 0x80);
    out.extend_from_slice(b);
    out
}

pub fn rlp_uint(v: u128) -> Vec<u8> {
    let be = v.to_be_bytes();
    let first = be.iter().position(|x| *x != 0).unwrap_or(be.len());
    rlp_bytes(&be[first..])
}

pub fn rlp_list(items: &[Vec<u8>]) -> Vec<u8> {
    let payload: Vec<u8> = items.concat();
    let mut out = rlp_len_prefix(payload.len(), 0xc0);
    out.extend_from_slice(&payload);
    out
}

fn rlp_len_prefix(len: usize, offset: u8) -> Vec<u8> {
    if len <= 55 {
        vec![offset + len as u8]
    } else {
        let be = (len as u64).to_be_bytes();
        let first = be.iter().position(|x| *x != 0).unwrap_or(be.len());
        let len_bytes = &be[first..];
        let mut out = vec![offset + 55 + len_bytes.len() as u8];
        out.extend_from_slice(len_bytes);
        out
    }
}

/// Parse a 0x-prefixed 20-byte hex address. Returns None if malformed.
pub fn parse_address(s: &str) -> Option<[u8; 20]> {
    let h = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X"))?;
    if h.len() != 40 {
        return None;
    }
    let v = hex::decode(h).ok()?;
    let mut a = [0u8; 20];
    a.copy_from_slice(&v);
    Some(a)
}

pub struct Eip1559Transfer {
    pub chain_id: u64,
    pub nonce: u64,
    pub max_priority_fee_per_gas: u128,
    pub max_fee_per_gas: u128,
    pub gas_limit: u64,
    pub to: [u8; 20],
    pub value: u128,
}

impl Eip1559Transfer {
    /// The unsigned typed-transaction bytes: 0x02 || rlp([...]).
    pub fn unsigned_bytes(&self) -> Vec<u8> {
        let list = rlp_list(&[
            rlp_uint(self.chain_id as u128),
            rlp_uint(self.nonce as u128),
            rlp_uint(self.max_priority_fee_per_gas),
            rlp_uint(self.max_fee_per_gas),
            rlp_uint(self.gas_limit as u128),
            rlp_bytes(&self.to),
            rlp_uint(self.value),
            rlp_bytes(&[]),
            rlp_list(&[]),
        ]);
        let mut out = vec![0x02];
        out.extend_from_slice(&list);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rlp_basics() {
        assert_eq!(rlp_uint(0), vec![0x80]);
        assert_eq!(rlp_uint(15), vec![0x0f]);
        assert_eq!(rlp_uint(1024), vec![0x82, 0x04, 0x00]);
        assert_eq!(rlp_bytes(b"dog"), vec![0x83, b'd', b'o', b'g']);
        assert_eq!(rlp_list(&[]), vec![0xc0]);
        let long = vec![0xaa; 56];
        let enc = rlp_bytes(&long);
        assert_eq!(&enc[..2], &[0xb8, 56]);
    }

    #[test]
    fn address_parsing() {
        assert!(parse_address("0x0000000000000000000000000000000000000001").is_some());
        assert!(parse_address("0x01").is_none());
        assert!(parse_address("zz00000000000000000000000000000000000001").is_none());
    }
}
