package com.gsuleimanov.sample.web;

import com.gsuleimanov.sample.domain.Profile;
import com.gsuleimanov.sample.service.ProfileService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RestController;

import java.util.Optional;

@RestController
public class ProfileController {

    private final ProfileService profileService;

    public ProfileController(ProfileService profileService) {
        this.profileService = profileService;
    }

    @GetMapping("/profiles/{id}")
    public Optional<Profile> get(@PathVariable Long id) {
        return profileService.getById(id);
    }
}
