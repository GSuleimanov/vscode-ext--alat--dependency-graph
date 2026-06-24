package com.gsuleimanov.sample.service;

import com.gsuleimanov.sample.domain.Profile;
import com.gsuleimanov.sample.repo.ProfileRepository;
import org.springframework.stereotype.Service;

import java.util.Optional;

@Service
public class CoachService {

    private final ProfileRepository profileRepository;
    private final ProfileService profileService;

    public CoachService(ProfileRepository profileRepository, ProfileService profileService) {
        this.profileRepository = profileRepository;
        this.profileService = profileService;
    }

    public Optional<Profile> coachProfile(Long id) {
        return profileRepository.findById(id);
    }

    public String coachInfo(Long id) {
        return profileService.getCoachInfo(id);
    }
}
