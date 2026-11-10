use std::ffi::OsString;
use std::path::PathBuf;

/// Explicit overrides must be absolute so startup never falls back to another
/// data directory after a misspelled or empty acceptance-test configuration.
pub fn resolve_data_dir(default: PathBuf, requested: Option<OsString>) -> Result<PathBuf, &'static str> {
    match requested {
        None => Ok(default),
        Some(value) => {
            let path = PathBuf::from(value);
            if !path.is_absolute() {
                return Err("APPLICATION_DATA_DIRECTORY_INVALID");
            }
            Ok(path)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_directory_is_preserved() {
        let default = std::env::temp_dir().join("oeon-default");
        assert_eq!(resolve_data_dir(default.clone(), None).unwrap(), default);
    }

    #[test]
    fn explicit_absolute_directory_is_used() {
        let requested = std::env::temp_dir().join("oeon-isolated");
        assert_eq!(resolve_data_dir(PathBuf::from("unused"), Some(requested.clone().into_os_string())).unwrap(), requested);
    }

    #[test]
    fn invalid_overrides_fail_without_using_the_default() {
        for value in ["", "relative", "../other"] {
            assert_eq!(resolve_data_dir(PathBuf::from("default"), Some(OsString::from(value))), Err("APPLICATION_DATA_DIRECTORY_INVALID"));
        }
    }
}
