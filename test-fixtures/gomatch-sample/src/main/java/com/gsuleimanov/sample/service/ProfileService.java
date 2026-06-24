package com.gsuleimanov.sample.service;

import com.gsuleimanov.sample.domain.Profile;
import com.gsuleimanov.sample.repo.ProfileRepository;
import org.springframework.stereotype.Service;

import java.util.Optional;

@Service
public class ProfileService {

    private final ProfileRepository profileRepository;

    public ProfileService(ProfileRepository profileRepository) {
        this.profileRepository = profileRepository;
    }

    // Method that *returns* the type Profile — must NOT be classified as a definition
    // of Profile when peeking the Profile type.
    public Profile loadProfile(Long id) {
        return profileRepository.findById(id).orElse(null);
    }

    public Optional<Profile> getById(Long id) {
        return profileRepository.findById(id);
    }

    // A plain project method, peeked to verify its callers are found.
    public String getCoachInfo(Long id) {
        return profileRepository.findById(id).map(Profile::getName).orElse("none");
    }
}
